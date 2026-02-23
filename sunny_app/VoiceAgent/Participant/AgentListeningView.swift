// Participant/AgentListeningView.swift
//
// Tooltip shown when the agent is actively listening before speech begins.
// Respects Reduce Motion — shimmer animation is suppressed when enabled.
// Accessibility: announces "Sunny is listening" to VoiceOver.

import SwiftUI

/// A tooltip that indicates the agent is recording and waiting for speech.
/// Shown in the center of the voice interaction view when no messages have arrived.
struct AgentListeningView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                Text("agent.listening")
            } else {
                Text("agent.listening")
                    .shimmering()
            }
        }
        .font(.system(size: 15))
        .transition(.blurReplace)
        .accessibilityLabel("Sunny is listening")
        .accessibilityAddTraits(.updatesFrequently)
    }
}

#Preview {
    AgentListeningView()
}
