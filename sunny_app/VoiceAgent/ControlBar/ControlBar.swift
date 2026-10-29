// ControlBar/ControlBar.swift
//
// Bottom action bar showing microphone, text input,
// and disconnect controls. All buttons meet the 60x60pt minimum tap target
// size required for senior accessibility.
//
// Reads SunnyTheme for accent color used on active/toggled states.
// Background uses SunnyColors.background (#EBC196) to match the app background.
// Accessibility: each button has an explicit accessibilityLabel.

import LiveKitComponents

/// A view that shows the control bar: audio/video and chat controls.
/// Available controls depend on the agent features and the track availability.
/// - SeeAlso: ``AgentFeatures``
struct ControlBar: View {
    @Environment(AppViewModel.self) private var viewModel
    @Environment(SunnyTheme.self) private var theme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private enum Constants {
        /// Minimum 60pt wide button for senior tap target compliance.
        static let buttonWidth: CGFloat = 60
        static let buttonHeight: CGFloat = 60
    }

    var body: some View {
        HStack(spacing: .zero) {
            biggerSpacer()
            if viewModel.agentFeatures.contains(.voice) {
                audioControls()
                flexibleSpacer()
            }
            if viewModel.agentFeatures.contains(.text) {
                textInputButton()
                flexibleSpacer()
            }
            disconnectButton()
            biggerSpacer()
        }
        .buttonStyle(
            ControlBarButtonStyle(
                foregroundColor: .fg1,
                backgroundColor: .bg2,
                borderColor: .separator1
            )
        )
        .font(.system(size: 17, weight: .medium))
        .frame(height: 15 * .grid)
        .overlay(
            RoundedRectangle(cornerRadius: 7.5 * .grid)
                .stroke(.separator1, lineWidth: 1)
        )
        .background(
            RoundedRectangle(cornerRadius: 7.5 * .grid)
                .fill(SunnyColors.background)
                .shadow(color: .black.opacity(0.1), radius: 10, y: 10)
        )
        .safeAreaPadding(.bottom, 8 * .grid)
        .safeAreaPadding(.horizontal, 16 * .grid)
    }

    // MARK: - Spacers

    /// Returns a flexible spacer capped at a size-class-dependent maximum width.
    ///
    /// purpose: Provide even spacing between control bar buttons that collapses
    ///          on compact-width devices to keep the bar from spreading too wide.
    private func flexibleSpacer() -> some View {
        Spacer()
            .frame(maxWidth: horizontalSizeClass == .regular ? 8 * .grid : 2 * .grid)
    }

    /// Returns a spacer that expands to fill available space, capped on regular widths.
    ///
    /// purpose: Push control groups to the edges of the bar on compact devices,
    ///          while capping at a fixed maximum on regular-width (iPad) layouts.
    private func biggerSpacer() -> some View {
        Spacer()
            .frame(maxWidth: horizontalSizeClass == .regular ? 8 * .grid : .infinity)
    }

    // MARK: - Controls

    private func audioControls() -> some View {
        HStack(spacing: .zero) {
            Spacer()
            AsyncButton(action: viewModel.toggleMicrophone) {
                HStack(spacing: .grid) {
                    Image(systemName: viewModel.isMicrophoneEnabled ? "microphone.fill" : "microphone.slash.fill")
                        .transition(.symbolEffect)
                    BarAudioVisualizer(audioTrack: viewModel.audioTrack, barColor: .fg1, barCount: 3, barSpacingFactor: 0.1)
                        .frame(width: 2 * .grid, height: 0.5 * Constants.buttonHeight)
                        .frame(maxHeight: .infinity)
                        .id(viewModel.audioTrack?.id)
                }
                .frame(width: Constants.buttonWidth, height: Constants.buttonHeight)
                .contentShape(Rectangle())
            }
            .accessibilityLabel(viewModel.isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone")
            Spacer()
        }
        .frame(width: Constants.buttonWidth)
    }

    private func textInputButton() -> some View {
        AsyncButton(action: viewModel.toggleTextInput) {
            Image(systemName: "ellipsis.message.fill")
                .frame(width: Constants.buttonWidth, height: Constants.buttonHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(
            ControlBarButtonStyle(
                isToggled: viewModel.interactionMode == .text,
                foregroundColor: .fg1,
                backgroundColor: .bg2,
                borderColor: .separator1
            )
        )
        .accessibilityLabel(viewModel.interactionMode == .text ? "Switch to voice" : "Switch to text")
        .disabled(viewModel.agent == nil)
    }

    private func disconnectButton() -> some View {
        AsyncButton(action: viewModel.disconnect) {
            Image(systemName: "phone.down.fill")
                .frame(width: Constants.buttonWidth, height: Constants.buttonHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(
            ControlBarButtonStyle(
                foregroundColor: .fgSerious,
                backgroundColor: .bgSerious,
                borderColor: .separatorSerious
            )
        )
        .accessibilityLabel("End conversation")
        .disabled(viewModel.connectionState == .disconnected)
    }
}

#Preview {
    ControlBar()
        .environment(AppViewModel())
        .environment(SunnyTheme())
}
