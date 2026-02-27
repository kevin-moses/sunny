// swiftformat:disable fileHeader
// VoiceAgentApp.swift
//
// SwiftUI App entry point and UIApplicationDelegate for the VoiceAgent app.
// Bootstraps Firebase Cloud Messaging, routes APNs tokens to FirebaseMessaging,
// handles cold-start notification tap context, and requests push notification
// permission on first launch. AgentFeatures defines the capability flags used
// throughout the app.
//
// Last modified: 2026-02-26

import FirebaseCore
import FirebaseMessaging
import LiveKit
import SwiftUI

@main
struct VoiceAgentApp: App {
    /// UIApplicationDelegate adaptor that handles APNs registration and Firebase init.
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    /// Root view model managing connection state and agent features.
    private let viewModel = AppViewModel()

    /// Shared theme object — drives all adjustable UI parameters via DevSettingsView.
    @State private var theme = SunnyTheme()

    var body: some Scene {
        WindowGroup {
            AppView()
                .environment(viewModel)
                .environment(theme)
                .task {
                    // Auto-connect if app was opened by tapping a notification (cold start).
                    // AppDelegate stores the parsed context in pendingContext before the scene appears.
                    if let ctx = NotificationService.shared.pendingContext {
                        NotificationService.shared.pendingContext = nil
                        await viewModel.connectFromNotification(context: ctx)
                    }
                }
                .task {
                    // Request push notification permission after the initial UX settles.
                    // Independent of any connect flow — runs concurrently with the connect task.
                    // requestPermission() is a no-op if the user has already decided.
                    try? await Task.sleep(for: .seconds(1))
                    _ = await NotificationService.shared.requestPermission()
                }
        }
        #if os(macOS)
        .defaultSize(width: 900, height: 900)
        #endif
        #if os(visionOS)
        .windowStyle(.plain)
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1500, height: 500)
        #endif
    }
}

// MARK: - AppDelegate

/// UIApplicationDelegate that initialises Firebase and routes APNs tokens to FirebaseMessaging.
final class AppDelegate: NSObject, UIApplicationDelegate {
    /// Configures Firebase, assigns FCM and UNUserNotificationCenter delegates, and
    /// handles any notification payload present in the launch options (cold-start tap).
    ///
    /// purpose: Bootstrap Firebase Cloud Messaging on launch so FCM tokens are available
    ///          before the first push arrives. Parses cold-start notification payloads and
    ///          stores them in NotificationService.shared.pendingContext for later pickup.
    /// @param application: (UIApplication) the app singleton
    /// @param launchOptions: optional launch option dictionary from UIKit
    /// @return Bool always true
    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        FirebaseApp.configure()
        Messaging.messaging().delegate = NotificationService.shared
        UNUserNotificationCenter.current().delegate = NotificationService.shared

        // Cold-start: app launched because the user tapped a push notification.
        // Parse the payload and store the context so VoiceAgentApp.body can auto-connect.
        if let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            if let ctx = NotificationService.shared.handleNotificationTap(userInfo: userInfo) {
                NotificationService.shared.pendingContext = ctx
            }
        }

        return true
    }

    /// Forwards the device APNs token to FirebaseMessaging so it can exchange it for an FCM token.
    ///
    /// purpose: Required step in the APNs → FCM token exchange. Without this, FCM cannot
    ///          deliver push notifications on iOS.
    /// @param application: (UIApplication) the app singleton
    /// @param deviceToken: (Data) the raw APNs device token bytes
    func application(
        _: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Messaging.messaging().apnsToken = deviceToken
    }

    /// Called when a remote notification arrives while the app is running in the background.
    ///
    /// purpose: Acknowledge background notifications so the system knows the app processed them.
    ///          Foreground and tap notifications are handled by UNUserNotificationCenterDelegate.
    /// @param application: (UIApplication) the app singleton
    /// @param userInfo: ([AnyHashable: Any]) the notification payload
    /// @param completionHandler: (UIBackgroundFetchResult) -> Void must be called to inform the OS
    func application(
        _: UIApplication,
        didReceiveRemoteNotification _: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        completionHandler(.newData)
    }
}

// MARK: - AgentFeatures

/// A set of flags that define the features supported by the agent.
/// Enable them based on your agent capabilities.
struct AgentFeatures: OptionSet {
    let rawValue: Int

    static let voice = Self(rawValue: 1 << 0)
    static let text = Self(rawValue: 1 << 1)
    static let video = Self(rawValue: 1 << 2)

    static let current: Self = [.voice, .text]
}
