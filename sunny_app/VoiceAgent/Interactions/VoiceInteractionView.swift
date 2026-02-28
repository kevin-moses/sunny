// VoiceAgent/Interactions/VoiceInteractionView.swift
//
// Purpose: Voice-mode interaction layout showing the agent participant view and
// the local camera preview (when camera is active). Layout adapts between compact
// (iPhone) and regular (iPad) horizontal size classes.
//
// Screen share preview is intentionally absent: rendering the local screen share
// track back to the user produces a confusing recursive mirror of the app.
// The ScreenShareStatusBanner in AppView provides the in-session sharing indicator.
// A remote agent-side view may be added in a future ticket (SCREEN-3+).

import SwiftUI

/// A multiplatform view that shows voice-specific interaction controls.
///
/// Depending on the track availability, the view will show:
/// - agent participant view
/// - local participant camera preview
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

    /// Regular (iPad) layout: agent view centered, camera preview pinned to the right column.
    ///
    /// purpose: Give the agent view prominence on wider displays while keeping the
    ///          local camera preview accessible in a fixed-width right column.
    private func regular() -> some View {
        HStack {
            Spacer()
                .frame(width: 50 * .grid)
            AgentParticipantView()
            VStack {
                Spacer()
                LocalParticipantView()
            }
            .frame(width: 50 * .grid)
        }
        .safeAreaPadding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Compact (iPhone) layout: agent view fills the screen, camera preview overlaid bottom-right.
    ///
    /// purpose: Maximize the agent view on small screens while keeping the local
    ///          camera preview visible as a floating overlay above the control bar.
    private func compact() -> some View {
        ZStack(alignment: .bottom) {
            AgentParticipantView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea()
            HStack {
                Spacer()
                LocalParticipantView()
            }
            .frame(height: 50 * .grid)
            .safeAreaPadding()
        }
    }
}
