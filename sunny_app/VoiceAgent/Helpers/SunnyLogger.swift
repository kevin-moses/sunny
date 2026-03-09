// Helpers/SunnyLogger.swift
//
// Purpose: Structured logging utility for the Sunny iOS app.
// Uses Apple's os.Logger for local Xcode/Console.app output (filterable by component and
// level). When a LiveKit room is attached (call attach(room:) after connect, detach() on
// disconnect), also forwards each log entry as a compact JSON data message on the "ios.log"
// topic so that iOS logs appear in the agent server terminal alongside Python log lines in
// real time, enabling cross-side failure diagnosis.
//
// Usage:
//   SunnyLogger.shared.info("RPC", "createReminder called", metadata: ["caller": caller])
//   SunnyLogger.shared.error("Contacts", "Access denied")
//
// Last modified: 2026-03-03

import Foundation
import LiveKit
import os

/// Structured logger that writes to os.Logger and forwards to the LiveKit data channel.
/// @unchecked Sendable: NSLock guards the mutable _room property.
final class SunnyLogger: @unchecked Sendable {
    /// Singleton instance used throughout the app.
    static let shared = SunnyLogger()

    private let subsystem: String
    private let roomLock = NSLock()
    private var _room: Room?

    private init() {
        subsystem = Bundle.main.bundleIdentifier ?? "com.sunny.app"
    }

    // MARK: - Room attachment

    /// Bind a connected LiveKit room so log entries are forwarded to the server terminal.
    /// Call this after room.connect() succeeds. Must be balanced with detach().
    /// @param room: (Room) Active LiveKit room to publish data messages on.
    func attach(room: Room) {
        roomLock.withLock { _room = room }
    }

    /// Unbind the room. Call this before or immediately on disconnect.
    func detach() {
        roomLock.withLock { _room = nil }
    }

    // MARK: - Log entry points

    /// Log a DEBUG-level message.
    /// @param component: (String) Short component name, e.g. "RPC", "Contacts".
    /// @param message: (String) Human-readable log message.
    /// @param metadata: ([String: Any]) Optional key-value pairs included in the JSON payload.
    func debug(_ component: String, _ message: String, metadata: [String: Any] = [:]) {
        emit(level: "DEBUG", osLevel: .debug, component: component, message: message, metadata: metadata)
    }

    /// Log an INFO-level message.
    /// @param component: (String) Short component name.
    /// @param message: (String) Human-readable log message.
    /// @param metadata: ([String: Any]) Optional key-value pairs included in the JSON payload.
    func info(_ component: String, _ message: String, metadata: [String: Any] = [:]) {
        emit(level: "INFO", osLevel: .info, component: component, message: message, metadata: metadata)
    }

    /// Log a WARNING-level message.
    /// @param component: (String) Short component name.
    /// @param message: (String) Human-readable log message.
    /// @param metadata: ([String: Any]) Optional key-value pairs included in the JSON payload.
    func warning(_ component: String, _ message: String, metadata: [String: Any] = [:]) {
        emit(level: "WARNING", osLevel: .error, component: component, message: message, metadata: metadata)
    }

    /// Log an ERROR-level message.
    /// @param component: (String) Short component name.
    /// @param message: (String) Human-readable log message.
    /// @param metadata: ([String: Any]) Optional key-value pairs included in the JSON payload.
    func error(_ component: String, _ message: String, metadata: [String: Any] = [:]) {
        emit(level: "ERROR", osLevel: .fault, component: component, message: message, metadata: metadata)
    }

    // MARK: - Internal

    /// Emit a log entry to os.Logger and optionally forward to the LiveKit data channel.
    /// @param level: (String) Log level label ("DEBUG", "INFO", "WARNING", "ERROR").
    /// @param osLevel: (OSLogType) Corresponding OSLogType for os.Logger.
    /// @param component: (String) Short component name used as the os.Logger category.
    /// @param message: (String) Human-readable log message.
    /// @param metadata: ([String: Any]) Optional structured metadata for the JSON payload.
    private func emit(
        level: String,
        osLevel: OSLogType,
        component: String,
        message: String,
        metadata: [String: Any]
    ) {
        // Write to os.Logger (visible in Xcode console and Console.app)
        let osLogger = Logger(subsystem: subsystem, category: component)
        osLogger.log(level: osLevel, "\(message, privacy: .public)")

        // Forward to the server via LiveKit data channel (fire-and-forget, unreliable)
        let room = roomLock.withLock { _room }
        guard let room else { return }

        var payload: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "level": level,
            "component": "ios.\(component)",
            "message": message,
        ]
        if !metadata.isEmpty {
            payload["metadata"] = metadata
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }

        Task {
            try? await room.localParticipant.publish(
                data: data,
                options: DataPublishOptions(topic: "ios.log", reliable: false)
            )
        }
    }
}
