// Start/StartView.swift
//
// The initial screen shown when the app is not connected.
// Displays an animated waveform and a large accessible connect button.
//
// Reads SunnyTheme for accent color, button font size, and corner radius.
// Accessibility: minimum 60x60pt tap target, VoiceOver labels, Dynamic Type,
// Reduce Motion support for the bar animation.

import SwiftUI

/// The initial view shown before connecting to a Sunny session.
struct StartView: View {
    @Environment(AppViewModel.self) private var viewModel
    @Environment(SunnyTheme.self) private var theme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Namespace private var button

    var body: some View {
        VStack(spacing: 8 * .grid) {
            bars()
            connectButton()
        }
        .padding(.horizontal, horizontalSizeClass == .regular ? 32 * .grid : 16 * .grid)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom, content: tip)
        #if os(visionOS)
            .glassBackgroundEffect()
            .frame(maxWidth: 175 * .grid)
        #endif
    }

    // MARK: - Sub-views

    /// Animated waveform bars tinted with the theme accent color.
    private func bars() -> some View {
        HStack(spacing: .grid) {
            ForEach(0 ..< 5, id: \.self) { index in
                Rectangle()
                    .fill(theme.accentColor)
                    .frame(width: 2 * .grid, height: barHeight(index))
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: 1.2).repeatForever(autoreverses: true).delay(Double(index) * 0.15),
                        value: reduceMotion
                    )
            }
        }
        .accessibilityHidden(true)
    }

    private func barHeight(_ index: Int) -> CGFloat {
        let heights: [CGFloat] = [2, 8, 12, 8, 2].map { $0 * .grid }
        return heights[index]
    }

    /// Small helper text at the bottom of the screen.
    private func tip() -> some View {
        VStack(spacing: 2 * .grid) {
            #if targetEnvironment(simulator)
            Text("connect.simulator")
                .foregroundStyle(.fgModerate)
            #endif
            Text("connect.tip")
                .foregroundStyle(.fg3)
        }
        .font(.system(size: theme.bodyFontSize - 4))
        .multilineTextAlignment(.center)
        .safeAreaPadding(.horizontal, horizontalSizeClass == .regular ? 32 * .grid : 16 * .grid)
        .safeAreaPadding(.vertical)
    }

    /// Full-width connect button. Minimum height 60pt for senior tap target.
    @ViewBuilder
    private func connectButton() -> some View {
        AsyncButton(action: viewModel.connect) {
            HStack {
                Spacer()
                Text("connect.start")
                    .matchedGeometryEffect(id: "connect", in: button)
                Spacer()
            }
            .frame(width: 58 * .grid, height: max(60, 11 * .grid))
        } busyLabel: {
            HStack(spacing: 4 * .grid) {
                Spacer()
                Spinner()
                    .transition(.scale.combined(with: .opacity))
                Text("connect.connecting")
                    .matchedGeometryEffect(id: "connect", in: button)
                Spacer()
            }
            .frame(width: 58 * .grid, height: max(60, 11 * .grid))
        }
        #if os(visionOS)
        .buttonStyle(.borderedProminent)
        .controlSize(.extraLarge)
        #else
        .buttonStyle(
            ProminentButtonStyle(
                accentColor: theme.accentColor,
                fontSize: theme.buttonFontSize,
                cornerRadius: theme.cornerRadius
            )
        )
        #endif
        .accessibilityLabel("Talk to Sunny")
        .accessibilityHint("Double-tap to connect and start speaking")
    }
}

#Preview {
    StartView()
        .environment(AppViewModel())
        .environment(SunnyTheme())
}
