// VoiceAgent/Interactions/VoiceInteractionView.swift
//
// Purpose: Voice-mode interaction layout showing the agent participant view.
// Layout adapts between compact (iPhone) and regular (iPad) horizontal size classes.

import SwiftUI

/// A view that shows voice-specific interaction controls.
///
/// - Note: The layout is determined by the horizontal size class.
struct VoiceInteractionView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        if horizontalSizeClass == .regular {
            regular()
        } else {
            compact()
        }
    }

    /// Regular (iPad) layout: agent view centered with fixed side margins.
    ///
    /// purpose: Give the agent view prominence on wider displays without stretching
    ///          it edge to edge.
    private func regular() -> some View {
        AgentParticipantView()
            .padding(.horizontal, 50 * .grid)
            .safeAreaPadding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Compact (iPhone) layout: agent view fills the screen.
    ///
    /// purpose: Maximize the agent view on small screens.
    private func compact() -> some View {
        AgentParticipantView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .ignoresSafeArea()
    }
}
