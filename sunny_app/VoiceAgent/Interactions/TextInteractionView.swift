// VoiceAgent/Interactions/TextInteractionView.swift
//
// Purpose: Text-mode interaction layout combining participant previews with a full
// chat view and text input. Shows the agent participant view and local camera preview
// above the chat history and input field.
//
// Screen share preview is intentionally absent: rendering the local screen share
// track back to the user produces a confusing recursive mirror of the app.
// The ScreenShareStatusBanner in AppView provides the in-session sharing indicator.

import SwiftUI

/// A multiplatform view that shows text-specific interaction controls.
///
/// Depending on the track availability, the view will show:
/// - agent participant view
/// - local participant camera preview
///
/// Additionally, the view shows a complete chat view with text input capabilities.
struct TextInteractionView: View {
    @Environment(AppViewModel.self) private var viewModel
    @FocusState.Binding var keyboardFocus: Bool

    var body: some View {
        VStack {
            VStack {
                participants()
                ChatView()
                #if os(macOS)
                    .frame(maxWidth: 128 * .grid)
                #endif
                    .blurredTop()
            }
            #if os(iOS)
            .contentShape(Rectangle())
            .onTapGesture {
                keyboardFocus = false
            }
            #endif
            ChatTextInputView(keyboardFocus: _keyboardFocus)
        }
    }

    /// Horizontal row of participant views shown above the chat history.
    ///
    /// purpose: Display the agent avatar and local camera preview in a compact
    ///          row that expands when a video track is active. Height collapses
    ///          to 25 grid units when no video is present to maximise chat space.
    private func participants() -> some View {
        HStack {
            Spacer()
            AgentParticipantView()
                .frame(maxWidth: viewModel.avatarCameraTrack != nil ? 50 * .grid : 25 * .grid)
            LocalParticipantView()
            Spacer()
        }
        .frame(height: viewModel.isCameraEnabled || viewModel.avatarCameraTrack != nil ? 50 * .grid : 25 * .grid)
        .safeAreaPadding()
    }
}
