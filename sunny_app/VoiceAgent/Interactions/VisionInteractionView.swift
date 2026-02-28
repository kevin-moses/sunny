// VoiceAgent/Interactions/VisionInteractionView.swift
//
// Purpose: visionOS-specific interaction layout with 3D-rotated panels for
// participants, agent, and chat. Shows the local camera preview in the left panel.
//
// Screen share preview is intentionally absent: rendering the local screen share
// track back to the user produces a confusing recursive mirror of the app.
// The ScreenShareStatusBanner in AppView provides the in-session sharing indicator.

import SwiftUI

#if os(visionOS)
/// A platform-specific view that shows all interaction controls with optional chat.
///
/// purpose: Lay out three 3D-rotated panels side by side — participants (left),
///          agent (center), chat (right) — for a spatially immersive visionOS experience.
struct VisionInteractionView: View {
    @Environment(AppViewModel.self) private var viewModel
    @FocusState.Binding var keyboardFocus: Bool

    var body: some View {
        HStack {
            participants().rotation3DEffect(.degrees(30), axis: .y, anchor: .trailing)
            agent()
            chat().rotation3DEffect(.degrees(-30), axis: .y, anchor: .leading)
        }
    }

    /// Left panel showing the local camera preview.
    ///
    /// purpose: Display the local participant view in a fixed-width column,
    ///          vertically centered with spacers for natural placement.
    private func participants() -> some View {
        VStack {
            Spacer()
            LocalParticipantView()
            Spacer()
        }
        .frame(width: 125 * .grid)
    }

    /// Center panel showing the agent participant view with a glass background.
    ///
    /// purpose: Give the agent view prominence as the focal point of the layout,
    ///          filling the available height in a fixed-width column.
    private func agent() -> some View {
        AgentParticipantView()
            .frame(width: 175 * .grid)
            .frame(maxHeight: .infinity)
            .glassBackgroundEffect()
    }

    /// Right panel showing the chat view and text input when in text interaction mode.
    ///
    /// purpose: Provide the chat history and input field in a fixed-width column,
    ///          only rendered when the interaction mode is .text.
    private func chat() -> some View {
        VStack {
            if case .text = viewModel.interactionMode {
                ChatView()
                ChatTextInputView(keyboardFocus: _keyboardFocus)
            }
        }
        .frame(width: 125 * .grid)
        .glassBackgroundEffect()
    }
}
#endif
