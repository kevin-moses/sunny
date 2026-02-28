// VoiceAgent/Views/BroadcastPickerView.swift
//
// Purpose: SwiftUI wrapper around RPSystemBroadcastPickerView that presents the
// system broadcast picker pre-configured for Sunny's extension. Uses the standard
// UIViewRepresentable pattern to embed a UIKit view. The picker is sized to fill
// its container and set to nearly-transparent (alpha 0.011) so it remains invisible
// but still intercepts touch events — triggering the system broadcast picker
// natively without any programmatic sendActions call.
//
// Only compiled on iOS — ReplayKit broadcast picker is iOS-only.

#if os(iOS)
import ReplayKit
import SwiftUI

/// A UIViewRepresentable that wraps RPSystemBroadcastPickerView, pre-configured
/// to auto-select Sunny's broadcast extension and hide the microphone toggle.
///
/// Purpose: Embed an invisible-but-tappable picker in the ControlBar so that
/// when the user taps the screen share button area (while not yet sharing),
/// the system broadcast picker appears pre-configured for Sunny's extension.
/// The alpha is set to 0.011 — invisible to the eye but still hittable by UIKit.
///
/// Usage: Overlay this view (sized to match the button frame) in a ZStack below
/// the custom SwiftUI button. The picker intercepts taps natively and presents
/// the system sheet — no programmatic trigger code needed.
struct BroadcastPickerView: UIViewRepresentable {
    /// The bundle ID of Sunny's broadcast extension.
    /// Pre-selects the extension so the system picker shows a single-tap start flow
    /// rather than a confusing list of available extensions.
    private static let extensionBundleID = "com.kmsunny.sunny.broadcast"

    /// Creates the RPSystemBroadcastPickerView with Sunny-specific configuration.
    ///
    /// purpose: Build and configure the picker with preferredExtension so the
    ///          system pre-selects Sunny's extension, and showsMicrophoneButton = false
    ///          to remove the microphone toggle from the dialog (audio is handled
    ///          by the main app's LiveKit audio track, not the extension).
    /// @param context: (Context) UIViewRepresentable coordinator context (unused)
    /// @return configured RPSystemBroadcastPickerView ready for embedding
    func makeUIView(context _: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: .zero)
        picker.preferredExtension = Self.extensionBundleID
        picker.showsMicrophoneButton = false
        picker.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Alpha 0.011: invisible to the human eye but still hittable by UIKit.
        // Required so the picker intercepts taps without blocking the underlying
        // custom SwiftUI button rendering.
        picker.alpha = 0.011
        return picker
    }

    /// No-op: the picker is fully configured on creation and requires no updates.
    ///
    /// purpose: Satisfy UIViewRepresentable protocol requirement.
    /// @param uiView: (RPSystemBroadcastPickerView) the existing picker view
    /// @param context: (Context) UIViewRepresentable coordinator context
    func updateUIView(_: RPSystemBroadcastPickerView, context _: Context) {}
}
#endif
