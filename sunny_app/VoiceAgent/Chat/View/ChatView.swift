// Chat/View/ChatView.swift
//
// Scrolling message feed showing user and agent transcript bubbles.
// Reads SunnyTheme for body font size and corner radius.
// Text color is BLACK per Sunny's design palette for maximum senior readability.
// Accessibility: VoiceOver labels distinguish user vs. agent messages.

import SwiftUI

/// A multiplatform view that shows the message feed.
struct ChatView: View {
    @Environment(ChatViewModel.self) private var viewModel
    @Environment(SunnyTheme.self) private var theme

    var body: some View {
        ScrollViewReader { scrollView in
            ScrollView {
                LazyVStack {
                    ForEach(viewModel.messages.values.reversed(), content: message)
                }
            }
            .onChange(of: viewModel.messages.count) {
                scrollView.scrollTo(viewModel.messages.keys.last)
            }
            .upsideDown()
            .padding(.horizontal)
            .scrollIndicators(.never)
            .animation(.default, value: viewModel.messages)
        }
    }

    // MARK: - Message rows

    private func message(_ message: ReceivedMessage) -> some View {
        ZStack {
            switch message.content {
            case let .userTranscript(text):
                userTranscript(text)
            case let .agentTranscript(text):
                agentTranscript(text)
            }
        }
        .upsideDown()
        .id(message.id)
    }

    /// Right-aligned bubble for the local user's speech.
    ///
    /// purpose: Render a user transcript message as a right-aligned bubble.
    /// @param text: (String) the transcript string to display
    private func userTranscript(_ text: String) -> some View {
        HStack {
            Spacer(minLength: 4 * .grid)
            Text(text.trimmingCharacters(in: .whitespacesAndNewlines))
                .font(.system(size: theme.bodyFontSize))
                .foregroundStyle(Color.black)
                .padding(.horizontal, 4 * .grid)
                .padding(.vertical, 2 * .grid)
                .background(
                    RoundedRectangle(cornerRadius: theme.cornerRadius)
                        .fill(theme.accentColor.opacity(0.12))
                )
        }
        .accessibilityLabel("You said: \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
    }

    /// Left-aligned plain text for Sunny's spoken responses.
    ///
    /// purpose: Render an agent transcript message as left-aligned plain text.
    /// @param text: (String) the transcript string to display
    private func agentTranscript(_ text: String) -> some View {
        HStack {
            Text(text.trimmingCharacters(in: .whitespacesAndNewlines))
                .font(.system(size: theme.bodyFontSize))
                .foregroundStyle(Color.black)
                .padding(.vertical, 2 * .grid)
            Spacer(minLength: 4 * .grid)
        }
        .accessibilityLabel("Sunny said: \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
}
