// Start/TalkButton.swift
//
// The Talk button: one large button that starts a voice session with Sunny. Shown at the
// bottom of the senior phone's Today view. Shows a spinner while connecting.
//
// Reads SunnyTheme for accent color, button font size, and corner radius.
// Accessibility: minimum 60pt tall tap target, VoiceOver label and hint, Dynamic Type.
//
// Memory-care pivot (2026-10-27): replaces StartView. The waveform start screen became
// the Today view (Calendar/TodayView.swift); only its connect button remains, here.

import SwiftUI

/// Full-width button that connects to a Sunny voice session.
struct TalkButton: View {
    @Environment(AppViewModel.self) private var viewModel
    @Environment(SunnyTheme.self) private var theme

    @Namespace private var button

    var body: some View {
        AsyncButton(action: viewModel.connect) {
            HStack {
                Spacer()
                Text("connect.start")
                    .matchedGeometryEffect(id: "connect", in: button)
                Spacer()
            }
            .frame(maxWidth: .infinity, minHeight: max(60, 11 * .grid))
        } busyLabel: {
            HStack(spacing: 4 * .grid) {
                Spacer()
                Spinner()
                    .transition(.scale.combined(with: .opacity))
                Text("connect.connecting")
                    .matchedGeometryEffect(id: "connect", in: button)
                Spacer()
            }
            .frame(maxWidth: .infinity, minHeight: max(60, 11 * .grid))
        }
        .buttonStyle(
            ProminentButtonStyle(
                accentColor: theme.accentColor,
                fontSize: theme.buttonFontSize,
                cornerRadius: theme.cornerRadius
            )
        )
        .accessibilityLabel("Talk to Sunny")
        .accessibilityHint("Double-tap to connect and start speaking")
    }
}

#Preview {
    TalkButton()
        .environment(AppViewModel())
        .environment(SunnyTheme())
}
