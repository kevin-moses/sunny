// App/AppViewModel.swift
//
// Purpose: Main view model for the Sunny app. Encapsulates root state and behaviors
// including LiveKit room connection, published tracks, interaction mode, microphone/camera/
// screen share toggles, RPC method registration, and device observation.
//
// Notification-tap auto-connect: observeNotificationTaps() bridges .sunnyNotificationTapped
// Foundation notifications into connectFromNotification(context:), which passes reminder
// metadata to the livekit-token edge function so the agent greets in context.
//
// Darwin broadcast listener (iOS only): setupBroadcastStopListener() registers a
// CFNotificationCenter observer for "iOS_BroadcastStopped" (posted by LKSampleHandler when
// the broadcast extension's broadcastFinished() fires). The callback bridges to a Foundation
// notification consumed by observeBroadcastStopped(), which forces room state back in sync
// if the extension was killed by iOS or stopped from Control Center.

@preconcurrency import AVFoundation
import Combine
import LiveKit
import Observation

/// Data structure for reminder creation
struct ReminderData: Codable {
    let title: String
    let notes: String?
    let due_date: String?
}

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
///
/// Darwin broadcast listener: Listens for the iOS_BroadcastStopped Darwin notification
/// posted by the system when the broadcast extension stops or crashes unexpectedly.
/// On receipt, forces isScreenShareEnabled = false and tells LiveKit to unpublish the
/// screen track so room state stays in sync even if the extension was killed by iOS.
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
    private(set) var isCameraEnabled = false
    private(set) var cameraTrack: (any VideoTrack)?
    private(set) var isScreenShareEnabled = false
    private(set) var screenShareTrack: (any VideoTrack)?

    private(set) var agentAudioTrack: (any AudioTrack)?
    private(set) var avatarCameraTrack: (any VideoTrack)?

    // MARK: Devices

    private(set) var audioDevices: [AudioDevice] = AudioManager.shared.inputDevices
    private(set) var selectedAudioDeviceID: String = AudioManager.shared.inputDevice.deviceId

    private(set) var videoDevices: [AVCaptureDevice] = []
    private(set) var selectedVideoDeviceID: String?

    private(set) var canSwitchCamera = false

    // MARK: - Dependencies

    @ObservationIgnored
    private var notificationObserverTask: Task<Void, Never>?
    @ObservationIgnored
    private var broadcastStopObserverTask: Task<Void, Never>?

    @ObservationIgnored
    @Dependency(\.room) private var room
    @ObservationIgnored
    @Dependency(\.tokenService) private var tokenService
    @ObservationIgnored
    @Dependency(\.errorHandler) private var errorHandler
    @ObservationIgnored
    @Dependency(\.reminderService) private var reminderService
    @ObservationIgnored
    @Dependency(\.contactService) private var contactService
    @ObservationIgnored
    @Dependency(\.messageService) private var messageService

    // MARK: - Initialization

    init(agentFeatures: AgentFeatures = .current) {
        self.agentFeatures = agentFeatures

        observeRoom()
        observeDevices()
        setupRpcMethods()
        observeNotificationTaps()
        #if os(iOS)
        setupBroadcastStopListener()
        observeBroadcastStopped()
        #endif
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

    #if os(iOS)
    /// Registers a Darwin notification observer for iOS_BroadcastStopped, bridging it
    /// to Foundation's NotificationCenter so it can be consumed in an async context.
    ///
    /// purpose: The broadcast extension posts iOS_BroadcastStopped to the Darwin
    ///          notification center when it stops (either normally or due to a crash /
    ///          memory kill). CFNotificationCenter callbacks are C-compatible functions,
    ///          so we bridge to Foundation NotificationCenter and handle the event in
    ///          observeBroadcastStopped() where we have full async/MainActor context.
    private func setupBroadcastStopListener() {
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            nil,
            { _, _, _, _, _ in
                NotificationCenter.default.post(
                    name: Notification.Name("sunny.darwinBroadcastStopped"),
                    object: nil
                )
            },
            "iOS_BroadcastStopped" as CFString,
            nil,
            .deliverImmediately
        )
    }

    /// Observes the Foundation bridge notification for iOS_BroadcastStopped and
    /// syncs LiveKit room state when the broadcast extension stops unexpectedly.
    ///
    /// purpose: If the broadcast extension is killed by iOS (e.g., memory limit exceeded)
    ///          or stopped from Control Center, LiveKit's room state may not update on its
    ///          own. This observer forces isScreenShareEnabled = false and calls
    ///          setScreenShare(enabled: false) to ensure the room track is unpublished and
    ///          the UI reflects the correct state. The Task is stored so it can be
    ///          cancelled in deinit to prevent a Task leak.
    private func observeBroadcastStopped() {
        broadcastStopObserverTask = Task { @MainActor [weak self] in
            for await _ in NotificationCenter.default.notifications(
                named: Notification.Name("sunny.darwinBroadcastStopped")
            ) {
                guard let self, isScreenShareEnabled else { continue }
                isScreenShareEnabled = false
                do {
                    try await room.localParticipant.setScreenShare(enabled: false)
                } catch {
                    // Room may already have unpublished the track; suppress the error.
                    #if DEBUG
                    print("[AppViewModel] observeBroadcastStopped setScreenShare error (suppressed): \(error)")
                    #endif
                }
            }
        }
    }
    #endif

    private func observeRoom() {
        Task { [weak self] in
            guard let changes = self?.room.changes else { return }
            for await _ in changes {
                guard let self else { return }

                connectionState = room.connectionState
                agent = room.agentParticipant

                isMicrophoneEnabled = room.localParticipant.isMicrophoneEnabled()
                audioTrack = room.localParticipant.firstAudioTrack
                isCameraEnabled = room.localParticipant.isCameraEnabled()
                cameraTrack = room.localParticipant.firstCameraVideoTrack
                isScreenShareEnabled = room.localParticipant.isScreenShareEnabled()
                screenShareTrack = room.localParticipant.firstScreenShareVideoTrack

                agentAudioTrack = room.agentParticipant?.audioTracks
                    .first(where: { $0.source == .microphone })?.track as? AudioTrack
                avatarCameraTrack = room.agentParticipant?.avatarWorker?.firstCameraVideoTrack
            }
        }
    }

    private func observeDevices() {
        Task {
            do {
                try AudioManager.shared.set(microphoneMuteMode: .inputMixer) // don't play mute sound effect
                try await AudioManager.shared.setRecordingAlwaysPreparedMode(true)

                AudioManager.shared.onDeviceUpdate = { [weak self] _ in
                    Task { @MainActor in
                        self?.audioDevices = AudioManager.shared.inputDevices
                        self?.selectedAudioDeviceID = AudioManager.shared.defaultInputDevice.deviceId
                    }
                }

                canSwitchCamera = try await CameraCapturer.canSwitchPosition()
                videoDevices = try await CameraCapturer.captureDevices()
                selectedVideoDeviceID = videoDevices.first?.uniqueID
            } catch {
                errorHandler(error)
            }
        }
    }

    deinit {
        AudioManager.shared.onDeviceUpdate = nil
        notificationObserverTask?.cancel()
        #if os(iOS)
        broadcastStopObserverTask?.cancel()
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            nil,
            CFNotificationName("iOS_BroadcastStopped" as CFString),
            nil
        )
        #endif
    }

    private func setupRpcMethods() {
        Task { [weak self] in
            do {
                try await self?.room.registerRpcMethod("createReminder") { data async throws -> String in
                    print("[RPC] createReminder from: \(data.callerIdentity)")
                    print("[RPC] payload: \(data.payload.prefix(200))")
                    do {
                        let reminderData = try JSONDecoder().decode(ReminderData.self, from: data.payload.data(using: .utf8) ?? Data())

                        // Use a fresh service instance to avoid crossing actors
                        let service = EventKitReminderService()
                        let result = try service.createReminder(
                            title: reminderData.title,
                            notes: reminderData.notes ?? "",
                            dueDate: reminderData.due_date ?? ""
                        )
                        print("[RPC] createReminder success: \(result)")
                        return result
                    } catch {
                        print("[RPC] createReminder error: \(error)")
                        return "Error creating reminder: \(error.localizedDescription)"
                    }
                }

                try await self?.room.registerRpcMethod("findContact") { data async throws -> String in
                    print("[RPC] findContact from: \(data.callerIdentity)")
                    print("[RPC] payload: \(data.payload.prefix(200))")
                    do {
                        let searchData = try JSONDecoder().decode(ContactSearchData.self, from: data.payload.data(using: .utf8) ?? Data())

                        // Use a fresh service instance to avoid crossing actors
                        let service = ContactService()
                        let contacts = try await service.findContacts(query: searchData.query)

                        // Return JSON array of contacts
                        let jsonData = try JSONEncoder().encode(contacts)
                        let result = String(data: jsonData, encoding: .utf8) ?? "[]"

                        print("[RPC] findContact success: found \(contacts.count) contacts")
                        return result
                    } catch {
                        print("[RPC] findContact error: \(error)")
                        return "[]" // Return empty array on error
                    }
                }

                try await self?.room.registerRpcMethod("sendMessage") { data async throws -> String in
                    print("[RPC] sendMessage from: \(data.callerIdentity)")
                    print("[RPC] payload: \(data.payload.prefix(200))")
                    do {
                        let messageData = try JSONDecoder().decode(MessageData.self, from: data.payload.data(using: .utf8) ?? Data())

                        // Use a fresh service instance to avoid crossing actors
                        let service = await MessageService()
                        let result = try await service.sendMessage(
                            contactId: messageData.contactId,
                            phoneNumber: messageData.phoneNumber,
                            message: messageData.message
                        )
                        print("[RPC] sendMessage success: \(result)")
                        return result
                    } catch {
                        print("[RPC] sendMessage error: \(error)")
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

    func toggleCamera() async {
        let enable = !isCameraEnabled
        do {
            // One video track at a time
            if enable, isScreenShareEnabled {
                try await room.localParticipant.setScreenShare(enabled: false)
            }

            let device = try await CameraCapturer.captureDevices().first(where: { $0.uniqueID == selectedVideoDeviceID })
            try await room.localParticipant.setCamera(enabled: enable, captureOptions: CameraCaptureOptions(device: device))
        } catch {
            errorHandler(error)
        }
    }

    func toggleScreenShare() async {
        let enable = !isScreenShareEnabled
        do {
            // One video track at a time
            if enable, isCameraEnabled {
                try await room.localParticipant.setCamera(enabled: false)
            }
            try await room.localParticipant.setScreenShare(enabled: enable)
        } catch {
            errorHandler(error)
        }
    }

    #if os(macOS)
    func select(audioDevice: AudioDevice) {
        selectedAudioDeviceID = audioDevice.deviceId

        let device = AudioManager.shared.inputDevices.first(where: { $0.deviceId == selectedAudioDeviceID }) ?? AudioManager.shared.defaultInputDevice
        AudioManager.shared.inputDevice = device
    }

    func select(videoDevice: AVCaptureDevice) async {
        selectedVideoDeviceID = videoDevice.uniqueID

        guard let cameraCapturer = getCameraCapturer() else { return }
        do {
            let captureOptions = CameraCaptureOptions(device: videoDevice)
            try await cameraCapturer.set(options: captureOptions)
        } catch {
            errorHandler(error)
        }
    }
    #endif

    func switchCamera() async {
        guard let cameraCapturer = getCameraCapturer() else { return }
        do {
            try await cameraCapturer.switchCameraPosition()
        } catch {
            errorHandler(error)
        }
    }

    private func getCameraCapturer() -> CameraCapturer? {
        guard let cameraTrack = cameraTrack as? LocalVideoTrack else { return nil }
        return cameraTrack.capturer as? CameraCapturer
    }
}
