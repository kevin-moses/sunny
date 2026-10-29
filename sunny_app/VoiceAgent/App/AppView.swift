// App/AppView.swift
//
// Purpose: Root view for the Sunny app. An unpaired device shows PairingView; a paired
// one shows its home surface (TodayView on the senior phone, DisplayView on the home
// display) and switches to the interactive conversation views (voice/text) while a
// session is live.
// Hosts the ControlBar in a bottom safeAreaInset. iOS only.
// Shows error/reconnecting banners via the errors() helper.

import SwiftUI

struct AppView: View {
    @Environment(AppViewModel.self) private var viewModel
    @Environment(SunnyTheme.self) private var theme

    @State private var chatViewModel = ChatViewModel()
    @State private var error: Error?
    @State private var showDevSettings = false
    @State private var pairedDevice = SunnyBackend.shared.pairedDevice

    @FocusState private var keyboardFocus: Bool
    @Namespace private var namespace

    var body: some View {
        ZStack(alignment: .top) {
            if viewModel.isInteractive {
                interactions()
            } else {
                start()
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
            .safeAreaInset(edge: .bottom) {
                if viewModel.isInteractive, !keyboardFocus {
                    ControlBar()
                        .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                }
            }
            .background(SunnyColors.background)
            .animation(.default, value: viewModel.isInteractive)
            .animation(.default, value: viewModel.interactionMode)
            .animation(.default, value: error?.localizedDescription)
            .onAppear {
                Dependencies.shared.errorHandler = { error = $0 }
            }
            .onReceive(NotificationCenter.default.publisher(for: .sunnyPairingLost)) { _ in
                pairedDevice = nil
            }
            .sensoryFeedback(.impact, trigger: viewModel.isListening)
    }

    // MARK: - Sub-views

    @ViewBuilder
    private func start() -> some View {
        switch pairedDevice?.kind {
        case .homeDisplay:
            DisplayView(householdId: pairedDevice?.householdId ?? "")
        case .seniorPhone:
            TodayView(householdId: pairedDevice?.householdId ?? "")
        case nil:
            PairingView { pairedDevice = $0 }
        }
    }

    @ViewBuilder
    private func interactions() -> some View {
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
    }

    @ViewBuilder
    private func errors() -> some View {
        if case .reconnecting = viewModel.connectionState {
            WarningView(warning: "warning.reconnecting")
        }

        if let error {
            ErrorView(error: error) { self.error = nil }
        }
    }

    private func agentListening() -> some View {
        ZStack {
            if chatViewModel.messages.isEmpty {
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
