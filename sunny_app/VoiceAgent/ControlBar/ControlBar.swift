// ControlBar/ControlBar.swift
//
// Bottom action bar showing microphone, camera, screen share, text input,
// and disconnect controls. All buttons meet the 60x60pt minimum tap target
// size required for senior accessibility.
//
// Reads SunnyTheme for accent color used on active/toggled states.
// Background uses SunnyColors.background (#EBC196) to match the app background.
// Accessibility: each button has an explicit accessibilityLabel.

import LiveKitComponents

/// A multiplatform view that shows the control bar: audio/video and chat controls.
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
            if viewModel.agentFeatures.contains(.video) {
                videoControls()
                flexibleSpacer()
                screenShareButton()
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
        #if !os(visionOS)
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
        #endif
    }

    // MARK: - Spacers

    private func flexibleSpacer() -> some View {
        Spacer()
            .frame(maxWidth: horizontalSizeClass == .regular ? 8 * .grid : 2 * .grid)
    }

    private func biggerSpacer() -> some View {
        Spacer()
            .frame(maxWidth: horizontalSizeClass == .regular ? 8 * .grid : .infinity)
    }

    private func separator() -> some View {
        Rectangle()
            .fill(.separator1)
            .frame(width: 1, height: 3 * .grid)
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
            #if os(macOS)
            separator()
            AudioDeviceSelector()
                .frame(height: Constants.buttonHeight)
            #endif
            Spacer()
        }
        .frame(width: Constants.buttonWidth)
    }

    private func videoControls() -> some View {
        HStack(spacing: .zero) {
            Spacer()
            AsyncButton(action: viewModel.toggleCamera) {
                Image(systemName: viewModel.isCameraEnabled ? "video.fill" : "video.slash.fill")
                    .transition(.symbolEffect)
                    .frame(width: Constants.buttonWidth, height: Constants.buttonHeight)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(viewModel.isCameraEnabled ? "Turn off camera" : "Turn on camera")
            #if os(macOS)
            separator()
            VideoDeviceSelector()
                .frame(height: Constants.buttonHeight)
            #endif
            Spacer()
        }
        .frame(width: Constants.buttonWidth)
        .disabled(viewModel.agent == nil)
    }

    private func screenShareButton() -> some View {
        AsyncButton(action: viewModel.toggleScreenShare) {
            Image(systemName: "arrow.up.square.fill")
                .frame(width: Constants.buttonWidth, height: Constants.buttonHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(
            ControlBarButtonStyle(
                isToggled: viewModel.isScreenShareEnabled,
                foregroundColor: .fg1,
                backgroundColor: .bg2,
                borderColor: .separator1
            )
        )
        .accessibilityLabel(viewModel.isScreenShareEnabled ? "Stop screen share" : "Start screen share")
        .disabled(viewModel.agent == nil)
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
