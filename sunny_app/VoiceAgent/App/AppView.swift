// App/AppView.swift
//
// Purpose: Root view for the Sunny app. Switches between StartView and the
// interactive conversation views (voice/text/vision) based on AppViewModel state.
// Hosts the ControlBar in a safeAreaInset (iOS) or ornament (visionOS).
// Overlays ScreenShareStatusBanner at the top while screen sharing is active,
// and shows error/reconnecting banners via the errors() helper.

import SwiftUI

struct AppView: View {
    @Environment(AppViewModel.self) private var viewModel
    @Environment(SunnyTheme.self) private var theme

    @State private var chatViewModel = ChatViewModel()
    @State private var error: Error?
    @State private var showDevSettings = false

    @FocusState private var keyboardFocus: Bool
    @Namespace private var namespace

    var body: some View {
        ZStack(alignment: .top) {
            if viewModel.isInteractive {
                interactions()
            } else {
                start()
            }

            if viewModel.isScreenShareEnabled {
                ScreenShareStatusBanner()
                    .zIndex(1)
            }

            errors()
        }
        #if DEBUG
        .overlay(alignment: .topTrailing) {
                devSettingsButton()
            }
        #endif
            .sheet(isPresented: $showDevSettings) {
                DevSettingsView()
                    .environment(theme)
            }
            .environment(\.namespace, namespace)
        #if os(visionOS)
            .ornament(attachmentAnchor: .scene(.bottom)) {
                if viewModel.isInteractive {
                    ControlBar()
                        .glassBackgroundEffect()
                }
            }
            .alert("warning.reconnecting", isPresented: .constant(viewModel.connectionState == .reconnecting)) {}
            .alert(error?.localizedDescription ?? "error.title", isPresented: .constant(error != nil)) {
                Button("error.ok") { error = nil }
            }
        #else
            .safeAreaInset(edge: .bottom) {
                if viewModel.isInteractive, !keyboardFocus {
                    ControlBar()
                        .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                }
            }
        #endif
            .background(SunnyColors.background)
            .animation(.default, value: viewModel.isInteractive)
            .animation(.default, value: viewModel.interactionMode)
            .animation(.default, value: viewModel.isCameraEnabled)
            .animation(.default, value: viewModel.isScreenShareEnabled)
            .animation(.default, value: error?.localizedDescription)
            .onAppear {
                Dependencies.shared.errorHandler = { error = $0 }
            }
        #if os(iOS)
            .sensoryFeedback(.impact, trigger: viewModel.isListening)
        #endif
    }

    // MARK: - Sub-views

    private func start() -> some View {
        StartView()
    }

    @ViewBuilder
    private func interactions() -> some View {
        #if os(visionOS)
        VisionInteractionView(keyboardFocus: $keyboardFocus)
            .environment(chatViewModel)
            .overlay(alignment: .bottom) {
                agentListening()
                    .padding(16 * .grid)
            }
        #else
        switch viewModel.interactionMode {
        case .text:
            TextInteractionView(keyboardFocus: $keyboardFocus)
                .environment(chatViewModel)
        case .voice:
            VoiceInteractionView()
                .overlay(alignment: .bottom) {
                    agentListening()
                        .padding()
                }
        }
        #endif
    }

    @ViewBuilder
    private func errors() -> some View {
        #if !os(visionOS)
        if case .reconnecting = viewModel.connectionState {
            WarningView(warning: "warning.reconnecting")
        }

        if let error {
            ErrorView(error: error) { self.error = nil }
        }
        #endif
    }

    private func agentListening() -> some View {
        ZStack {
            if chatViewModel.messages.isEmpty,
               !viewModel.isCameraEnabled,
               !viewModel.isScreenShareEnabled
            {
                AgentListeningView()
            }
        }
        .animation(.default, value: chatViewModel.messages.isEmpty)
    }

    // MARK: - Dev Settings Button (DEBUG only)

    /// Floating pill button in the top-right safe area that opens DevSettingsView.
    /// Only compiled in DEBUG builds — not present in release.
    private func devSettingsButton() -> some View {
        Button {
            showDevSettings = true
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill(theme.accentColor)
                    .frame(width: 8, height: 8)
                Text("DEV")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().stroke(theme.accentColor.opacity(0.4), lineWidth: 1))
        }
        .accessibilityLabel("Open developer settings")
        .padding(.top, 8)
        .padding(.trailing, 16)
    }
}

#Preview {
    AppView()
        .environment(AppViewModel())
        .environment(SunnyTheme())
}
