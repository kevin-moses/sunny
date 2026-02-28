// VoiceAgent/Views/ScreenShareStatusBanner.swift
//
// Purpose: Overlay banner displayed at the top of the conversation view while
// screen sharing is active. Informs the senior that Sunny can see their screen.
// Shown/hidden reactively based on AppViewModel.isScreenShareEnabled.
// Styled with a green background to clearly signal an "active / recording" state.

import SwiftUI

/// A full-width banner shown at the top of the screen during an active broadcast session.
///
/// Purpose: Provide a clear, persistent visual indicator that screen sharing is
/// active so seniors are always aware Sunny can see their screen. The green
/// background is universally understood as "on" or "active."
/// Dismissed automatically when isScreenShareEnabled becomes false in the parent.
struct ScreenShareStatusBanner: View {
    /// The banner body: a full-width label with a green background.
    ///
    /// purpose: Render the sharing-active indicator with sufficient contrast
    ///          for senior readability — semibold text, white on green.
    ///          The transition is applied here so the banner slides in from the top
    ///          and fades out when removed from the hierarchy.
    var body: some View {
        Text("Sunny can see your screen")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(Color.green.opacity(0.85))
            .transition(.move(edge: .top).combined(with: .opacity))
    }
}
