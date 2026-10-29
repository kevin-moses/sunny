// VoiceAgent/Interactions/TextInteractionView.swift
//
// Purpose: Text-mode interaction layout combining the agent participant view with a
// full chat view and text input.

import SwiftUI

/// A view that shows text-specific interaction controls.
///
/// Shows the agent participant view above a complete chat view with text input.
struct TextInteractionView: View {
    @Environment(AppViewModel.self) private var viewModel
    @FocusState.Binding var keyboardFocus: Bool

    var body: some View {
        VStack {
            VStack {
                participants()
                ChatView()
                    .blurredTop()
            }
            .contentShape(Rectangle())
            .onTapGesture {
                keyboardFocus = false
            }
            ChatTextInputView(keyboardFocus: _keyboardFocus)
        }
    }

    /// Horizontal row of participant views shown above the chat history.
    ///
    /// purpose: Display the agent avatar in a compact row that expands when the agent
    ///          has a video track. Height collapses to 25 grid units when no video is
    ///          present to maximise chat space.
    private func participants() -> some View {
        HStack {
            Spacer()
            AgentParticipantView()
                .frame(maxWidth: viewModel.avatarCameraTrack != nil ? 50 * .grid : 25 * .grid)
            Spacer()
        }
        .frame(height: viewModel.avatarCameraTrack != nil ? 50 * .grid : 25 * .grid)
        .safeAreaPadding()
    }
}
