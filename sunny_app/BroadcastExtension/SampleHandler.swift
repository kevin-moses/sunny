// BroadcastExtension/SampleHandler.swift
//
// Purpose: ReplayKit Broadcast Upload Extension entry point for Sunny.
// This extension runs in a separate process from the main app (50MB memory limit).
// It receives CMSampleBuffer frames from ReplayKit and forwards them to the LiveKit
// room via LKSampleHandler, which handles H.264 encoding and WebRTC transport.
// The App Group (group.com.kmsunny.sunny) enables IPC with the main app.

#if os(iOS)
import LiveKit

/// The ReplayKit sample handler subclass that powers Sunny's screen sharing broadcast extension.
///
/// LKSampleHandler (from the LiveKit Swift SDK) handles all frame encoding and
/// WebRTC publishing. The extension is limited to 50MB of RAM by iOS; LKSampleHandler
/// uses H.264 (not VP8) to stay within this budget.
///
/// @unchecked Sendable: LKSampleHandler is thread-safe per the LiveKit SDK contract
/// but is not declared Sendable; this conformance suppresses the Swift 6 concurrency warning.
class SampleHandler: LKSampleHandler, @unchecked Sendable {
    /// When true, LiveKit logs extension activity to the system console.
    /// Gated on DEBUG to avoid verbose output in production builds.
    override var enableLogging: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}
#endif
