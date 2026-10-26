// App/AppViewModel.swift
//
// Purpose: Main view model for the Sunny app. Encapsulates root state and behaviors
// including LiveKit room connection, published tracks, interaction mode, microphone
// toggle, audio session setup, and RPC method registration.
//
// Notification-tap auto-connect: observeNotificationTaps() bridges .sunnyNotificationTapped
// Foundation notifications into connectFromNotification(context:), which passes reminder
// metadata to the livekit-token edge function so the agent greets in context.
//
// Logging: SunnyLogger.shared is attached to the room after successful connect and detached
// on disconnect, forwarding structured iOS log entries to the agent server terminal in
// real time so both iOS and Python logs are visible in the same timeline.

import Combine
import Foundation
import LiveKit
import Observation

/// Data structure for contact search
struct ContactSearchData: Codable {
    let query: String
}

/// Data structure for message sending
struct MessageData: Codable {
    let contactId: String
    let phoneNumber: String
    let message: String
}

/// The main view model encapsulating root states and behaviors of the app
/// such as connection, published tracks, etc.
///
/// It consumes `LiveKit.Room` object, observing its internal state and propagating appropriate changes.
/// It does not expose any publicly mutable state, encouraging unidirectional data flow.
///
/// Notification-tap auto-connect: When a push notification is tapped, NotificationService
/// broadcasts .sunnyNotificationTapped. AppViewModel observes this and calls
/// connectFromNotification(context:), which stores the context then calls connect().
/// getConnection() picks up the pending context and passes it to the livekit-token edge
/// function so the agent receives reminder metadata in participant metadata.
@MainActor
@Observable
final class AppViewModel {
    // MARK: - Constants

    private enum Constants {
        static let agentConnectionTimeout: TimeInterval = 20
    }

    // MARK: - Errors

    enum Error: LocalizedError {
        case agentNotConnected

        var errorDescription: String? {
            switch self {
            case .agentNotConnected:
                "Agent did not connect to the Room"
            }
        }
    }

    // MARK: - Modes

    enum InteractionMode {
        case voice
        case text
    }

    let agentFeatures: AgentFeatures

    // MARK: - State

    // MARK: Connection

    /// Reminder context from a notification tap, cleared after getConnection() consumes it.
    private(set) var pendingNotificationContext: NotificationContext?

    private(set) var connectionState: ConnectionState = .disconnected
    private(set) var isListening = false
    var isInteractive: Bool {
        switch connectionState {
        case .disconnected where isListening,
             .connecting where isListening,
             .connected,
             .reconnecting:
            true
        default:
            false
        }
    }

    private(set) var agent: Participant?

    private(set) var interactionMode: InteractionMode = .voice

    // MARK: Tracks

    private(set) var isMicrophoneEnabled = false
    private(set) var audioTrack: (any AudioTrack)?

    private(set) var agentAudioTrack: (any AudioTrack)?
    private(set) var avatarCameraTrack: (any VideoTrack)?

    // MARK: - Dependencies

    @ObservationIgnored
    private var notificationObserverTask: Task<Void, Never>?

    @ObservationIgnored
    @Dependency(\.room) private var room
    @ObservationIgnored
    @Dependency(\.tokenService) private var tokenService
    @ObservationIgnored
    @Dependency(\.errorHandler) private var errorHandler
    @ObservationIgnored
    @Dependency(\.contactService) private var contactService
    @ObservationIgnored
    @Dependency(\.messageService) private var messageService

    // MARK: - Initialization

    init(agentFeatures: AgentFeatures = .current) {
        self.agentFeatures = agentFeatures

        observeRoom()
        configureAudio()
        setupRpcMethods()
        observeNotificationTaps()
    }

    /// Subscribes to .sunnyNotificationTapped Foundation notifications so that tapping a
    /// push notification while the app is running auto-connects with reminder context.
    ///
    /// purpose: Bridge Foundation NotificationCenter events (posted by NotificationService)
    ///          into an async connect call that passes the reminder context to livekit-token.
    ///          The Task is stored in notificationObserverTask so it is cancelled in deinit,
    ///          preventing a Task leak if the view model scope ever changes.
    private func observeNotificationTaps() {
        notificationObserverTask = Task { @MainActor [weak self] in
            for await notification in NotificationCenter.default.notifications(named: .sunnyNotificationTapped) {
                guard let self, let ctx = notification.object as? NotificationContext else { continue }
                await connectFromNotification(context: ctx)
            }
        }
    }

    private func observeRoom() {
        Task { [weak self] in
            guard let changes = self?.room.changes else { return }
            for await _ in changes {
                guard let self else { return }

                connectionState = room.connectionState
                agent = room.agentParticipant

                isMicrophoneEnabled = room.localParticipant.isMicrophoneEnabled()
                audioTrack = room.localParticipant.firstAudioTrack

                agentAudioTrack = room.agentParticipant?.audioTracks
                    .first(where: { $0.source == .microphone })?.track as? AudioTrack
                avatarCameraTrack = room.agentParticipant?.avatarWorker?.firstCameraVideoTrack
            }
        }
    }

    /// Configures the shared LiveKit audio session once at startup.
    ///
    /// purpose: Mute through the input mixer (no mute sound effect) and keep recording
    ///          prepared so the microphone starts without delay when a session connects.
    private func configureAudio() {
        Task {
            do {
                try AudioManager.shared.set(microphoneMuteMode: .inputMixer) // don't play mute sound effect
                try await AudioManager.shared.setRecordingAlwaysPreparedMode(true)
            } catch {
                errorHandler(error)
            }
        }
    }

    deinit {
        notificationObserverTask?.cancel()
    }

    private func setupRpcMethods() {
        Task { [weak self] in
            do {
                try await self?.room.registerRpcMethod("findContact") { data async throws -> String in
                    SunnyLogger.shared.info("RPC", "findContact from: \(data.callerIdentity)",
                                            metadata: ["payload_preview": String(data.payload.prefix(200))])
                    do {
                        let searchData = try JSONDecoder().decode(ContactSearchData.self, from: data.payload.data(using: .utf8) ?? Data())

                        // Use a fresh service instance to avoid crossing actors
                        let service = ContactService()
                        let contacts = try await service.findContacts(query: searchData.query)

                        // Return JSON array of contacts
                        let jsonData = try JSONEncoder().encode(contacts)
                        let result = String(data: jsonData, encoding: .utf8) ?? "[]"

                        SunnyLogger.shared.info("RPC", "findContact success", metadata: ["count": contacts.count])
                        return result
                    } catch {
                        SunnyLogger.shared.error("RPC", "findContact error: \(error)")
                        return "[]" // Return empty array on error
                    }
                }

                try await self?.room.registerRpcMethod("sendMessage") { data async throws -> String in
                    SunnyLogger.shared.info("RPC", "sendMessage from: \(data.callerIdentity)",
                                            metadata: ["payload_preview": String(data.payload.prefix(200))])
                    do {
                        let messageData = try JSONDecoder().decode(MessageData.self, from: data.payload.data(using: .utf8) ?? Data())

                        // Use a fresh service instance to avoid crossing actors
                        let service = await MessageService()
                        let result = try await service.sendMessage(
                            contactId: messageData.contactId,
                            phoneNumber: messageData.phoneNumber,
                            message: messageData.message
                        )
                        SunnyLogger.shared.info("RPC", "sendMessage success: \(result)")
                        return result
                    } catch {
                        SunnyLogger.shared.error("RPC", "sendMessage error: \(error)")
                        return "Error sending message: \(error.localizedDescription)"
                    }
                }
            } catch {
                self?.errorHandler(error)
            }
        }
    }

    private func resetState() {
        isListening = false
        interactionMode = .voice
    }

    // MARK: - Connection

    /// Initiates a LiveKit session pre-loaded with reminder context from a notification tap.
    ///
    /// purpose: Stores the NotificationContext so getConnection() can embed it in the
    ///          livekit-token request, then delegates to connect() for the full connect flow.
    ///          The agent receives the context via participant metadata and greets in context.
    /// @param context: (NotificationContext) reminder context parsed from the notification payload
    func connectFromNotification(context: NotificationContext) async {
        pendingNotificationContext = context
        await connect()
    }

    func connect() async {
        errorHandler(nil)
        resetState()
        do {
            if agentFeatures.contains(.voice) {
                try await connectWithVoice()
            } else {
                try await connectWithoutVoice()
            }

            SunnyLogger.shared.attach(room: room)
            try await checkAgentConnected()
        } catch {
            errorHandler(error)
            resetState()
        }
    }

    /// Connect and enable microphone, capture pre-connect audio
    private func connectWithVoice() async throws {
        try await room.withPreConnectAudio {
            await MainActor.run { self.isListening = true }

            let connectionDetails = try await self.getConnection()

            try await self.room.connect(
                url: connectionDetails.serverUrl,
                token: connectionDetails.participantToken,
                connectOptions: .init(enableMicrophone: true)
            )
        }
    }

    /// Connect without enabling microphone
    private func connectWithoutVoice() async throws {
        let connectionDetails = try await getConnection()

        try await room.connect(
            url: connectionDetails.serverUrl,
            token: connectionDetails.participantToken,
            connectOptions: .init(enableMicrophone: false)
        )
    }

    /// Fetches LiveKit connection details, embedding notification context when present.
    ///
    /// purpose: When pendingNotificationContext is set (user tapped a reminder notification),
    ///          bypass the sandbox TokenService and call the Supabase livekit-token function
    ///          directly so that trigger/reminderId/adherenceLogId are embedded in participant
    ///          metadata. The agent reads these to deliver a reminder-aware greeting.
    ///          Falls back to the standard tokenService path for normal app-open sessions.
    /// @return TokenService.ConnectionDetails with serverUrl and participantToken
    private func getConnection() async throws -> TokenService.ConnectionDetails {
        let roomName = "room-\(Int.random(in: 1000 ... 9999))"
        let participantName = "user-\(Int.random(in: 1000 ... 9999))"

        if let context = pendingNotificationContext {
            pendingNotificationContext = nil
            return try await SunnyAPIClient.shared.fetchLiveKitToken(
                roomName: roomName,
                participantName: participantName,
                notificationContext: context
            )
        }

        return try await tokenService.fetchConnectionDetails(
            roomName: roomName,
            participantName: participantName
        )!
    }

    func disconnect() async {
        SunnyLogger.shared.detach()
        await room.disconnect()
        resetState()
    }

    private func checkAgentConnected() async throws {
        try await Task.sleep(for: .seconds(Constants.agentConnectionTimeout))
        if connectionState == .connected, agent == nil {
            await disconnect()
            throw Error.agentNotConnected
        }
    }

    // MARK: - Actions

    func toggleTextInput() {
        switch interactionMode {
        case .voice:
            interactionMode = .text
        case .text:
            interactionMode = .voice
        }
    }

    func toggleMicrophone() async {
        do {
            try await room.localParticipant.setMicrophone(enabled: !isMicrophoneEnabled)
        } catch {
            errorHandler(error)
        }
    }
}
