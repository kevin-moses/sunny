// Services/NotificationService.swift
//
// Manages iOS push notification permissions, FCM token registration, and
// notification tap handling for reminder-triggered LiveKit sessions.
//
// FCM flow:
//   1. requestPermission() asks UNUserNotificationCenter for alert/sound/badge rights.
//   2. On grant, UIApplication.registerForRemoteNotifications() fetches the APNs token.
//   3. AppDelegate forwards the APNs token to Messaging.messaging().apnsToken.
//   4. FirebaseMessaging exchanges APNs token → FCM token and calls
//      messaging(_:didReceiveRegistrationToken:) on this service.
//   5. This service POSTs the FCM token to save-device-token via SunnyAPIClient.
//
// Notification tap flow:
//   - Foreground/background: userNotificationCenter(_:didReceive:) fires, parses the
//     payload, stores pendingContext, and broadcasts .sunnyNotificationTapped so that
//     AppViewModel can auto-connect with reminder context.
//   - Cold start: AppDelegate reads launchOptions[.remoteNotification] and stores the
//     parsed context in pendingContext; VoiceAgentApp.body reads it on first appear.
//
// Prerequisites: FirebaseMessaging SPM package must be added in Xcode before this
// file will compile. See sunny_app/FIREBASE_SETUP.md for setup instructions.
//
// Last modified: 2026-02-26

import FirebaseMessaging
import UIKit
import UserNotifications

// MARK: - Notification name

extension Notification.Name {
    /// Posted when the user taps a push notification while the app is running.
    /// The `object` is a `NotificationContext` value.
    static let sunnyNotificationTapped = Notification.Name("SunnyNotificationTapped")
}

// MARK: - NotificationContext

/// Parsed reminder context extracted from a push notification payload.
struct NotificationContext {
    /// What initiated this session — always "notification_tap" when coming from a push.
    let trigger: String
    /// UUID of the reminders row that fired this notification, if applicable.
    let reminderId: String?
    /// Human-readable title of the reminder, used for the agent's initial greeting.
    let reminderTitle: String?
    /// Category of the reminder (e.g. "medication", "appointment").
    let reminderType: String?
    /// UUID of the adherence_log row created when the notification was dispatched.
    let adherenceLogId: String?
}

// MARK: - NotificationService

/// Singleton that owns notification permission, FCM token lifecycle, and tap handling.
/// Set as both UNUserNotificationCenterDelegate and MessagingDelegate in AppDelegate.
@MainActor
final class NotificationService: NSObject {
    /// Shared singleton — set as delegate in AppDelegate before any notifications arrive.
    static let shared = NotificationService()

    /// Holds a pending NotificationContext from a cold-start notification tap until
    /// VoiceAgentApp.body can read it and trigger auto-connect.
    var pendingContext: NotificationContext?

    override private init() {
        super.init()
    }

    // MARK: - Permission

    /// Requests UNUserNotificationCenter authorization and registers for remote notifications.
    ///
    /// purpose: Ask the user for alert, sound, and badge permission. Registers with APNs on
    ///          grant so the APNs token can be forwarded to FirebaseMessaging for FCM exchange.
    ///          Safe to call repeatedly — the system presents the prompt only once.
    /// @return Bool — true if the user granted permission, false if denied or if an error occurred
    func requestPermission() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
            return granted
        } catch {
            return false
        }
    }

    // MARK: - Payload parsing

    /// Parses a push notification userInfo dictionary into a NotificationContext.
    ///
    /// purpose: Extract reminder context from the aps payload so that AppViewModel can
    ///          pass it to the livekit-token function and let the agent greet in context.
    ///          Returns nil if the payload is not a Sunny reminder notification.
    /// @param userInfo: ([AnyHashable: Any]) raw notification payload dictionary
    /// @return NotificationContext if the payload contains a reminder_id, nil otherwise
    func handleNotificationTap(userInfo: [AnyHashable: Any]) -> NotificationContext? {
        guard let reminderId = userInfo["reminder_id"] as? String else {
            return nil
        }
        return NotificationContext(
            trigger: "notification_tap",
            reminderId: reminderId,
            reminderTitle: userInfo["reminder_title"] as? String,
            reminderType: userInfo["reminder_type"] as? String,
            adherenceLogId: userInfo["adherence_log_id"] as? String
        )
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationService: UNUserNotificationCenterDelegate {
    /// Called when the user taps a notification while the app is in the foreground or background.
    ///
    /// purpose: Parse the tapped notification payload into a NotificationContext, store it as
    ///          pendingContext, and broadcast .sunnyNotificationTapped so AppViewModel can
    ///          auto-connect with reminder context.
    /// @param center: (UNUserNotificationCenter) the notification center
    /// @param response: (UNNotificationResponse) contains the tapped notification and action
    /// @param completionHandler: () -> Void must be called when handling is complete
    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // UNUserNotificationCenterDelegate callbacks are always delivered on the main thread.
        // Extract only Sendable (String?) values from the non-Sendable response/userInfo
        // before entering assumeIsolated so no non-Sendable types cross the boundary.
        let info = response.notification.request.content.userInfo
        let reminderId = info["reminder_id"] as? String
        let reminderTitle = info["reminder_title"] as? String
        let reminderType = info["reminder_type"] as? String
        let adherenceLogId = info["adherence_log_id"] as? String

        MainActor.assumeIsolated {
            guard let reminderId else { return }
            let ctx = NotificationContext(
                trigger: "notification_tap",
                reminderId: reminderId,
                reminderTitle: reminderTitle,
                reminderType: reminderType,
                adherenceLogId: adherenceLogId
            )
            pendingContext = ctx
            NotificationCenter.default.post(name: .sunnyNotificationTapped, object: ctx)
        }
        completionHandler()
    }

    /// Called when a notification arrives while the app is in the foreground.
    ///
    /// purpose: Show the notification banner even when the app is active so the user
    ///          can see the reminder and choose to tap it.
    /// @param center: (UNUserNotificationCenter) the notification center
    /// @param notification: (UNNotification) the incoming notification
    /// @param completionHandler: (UNNotificationPresentationOptions) -> Void display options callback
    nonisolated func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}

// MARK: - MessagingDelegate

extension NotificationService: MessagingDelegate {
    /// Called by FirebaseMessaging when a new or refreshed FCM token is available.
    ///
    /// purpose: Forward the FCM token to the backend so the server can send push
    ///          notifications to this device. Uses an upsert so refreshes are safe.
    /// @param messaging: (Messaging) the Firebase Messaging singleton
    /// @param fcmToken: (String?) the new FCM registration token, nil if unavailable
    nonisolated func messaging(_: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let token = fcmToken else { return }
        Task {
            do {
                try await SunnyAPIClient.shared.saveDeviceToken(token)
            } catch {
                // Log but do not propagate — FCM will retry on the next token refresh cycle
                SunnyLogger.shared.warning("NotificationService", "Failed to save FCM token: \(error)")
            }
        }
    }
}
