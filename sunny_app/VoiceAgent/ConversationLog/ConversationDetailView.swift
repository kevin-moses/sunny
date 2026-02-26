import SwiftUI

/// Full transcript view for a single conversation.
/// User messages are right-aligned with accent tint; assistant messages are left-aligned plain text.
/// Pushes onto the ConversationListView NavigationStack.
struct ConversationDetailView: View {
    /// The conversation whose messages to display.
    let conversation: ConversationItem

    @Environment(SunnyTheme.self) private var theme

    @State private var messages: [MessageItem] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 4 * .grid) {
                if isLoading, messages.isEmpty {
                    ProgressView("Loading transcript...")
                        .frame(maxWidth: .infinity, alignment: .center)
                }

                if let errorMessage {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                ForEach(filteredMessages) { message in
                    messageRow(message)
                }

                if let summary = conversationSummary {
                    summaryCard(summary)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 2 * .grid)
        }
        .navigationTitle(Self.dateFormatter.string(from: conversation.startedAt))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await load()
        }
    }

    private var filteredMessages: [MessageItem] {
        messages.filter { $0.role == "user" || $0.role == "assistant" }
    }

    private var conversationSummary: String? {
        guard let summary = conversation.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty else {
            return nil
        }
        return summary
    }

    /// Renders a single message bubble.
    ///
    /// purpose: Render user (right, accent tint) or assistant (left, plain) bubble.
    /// @param message: (MessageItem) the message to render; system/tool roles render EmptyView
    @ViewBuilder
    private func messageRow(_ message: MessageItem) -> some View {
        let text = message.content.trimmingCharacters(in: .whitespacesAndNewlines)

        switch message.role {
        case "user":
            HStack {
                Spacer(minLength: 4 * .grid)
                Text(text)
                    .font(.system(size: theme.bodyFontSize))
                    .foregroundStyle(Color.black)
                    .padding(.horizontal, 4 * .grid)
                    .padding(.vertical, 2 * .grid)
                    .background(
                        RoundedRectangle(cornerRadius: theme.cornerRadius)
                            .fill(theme.accentColor.opacity(0.12))
                    )
            }
        case "assistant":
            HStack {
                Text(text)
                    .font(.system(size: theme.bodyFontSize))
                    .foregroundStyle(Color.black)
                    .padding(.vertical, 2 * .grid)
                Spacer(minLength: 4 * .grid)
            }
        default:
            EmptyView()
        }
    }

    private func summaryCard(_ summary: String) -> some View {
        VStack(alignment: .leading, spacing: 2 * .grid) {
            Text("Summary")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(summary)
                .font(.system(size: theme.bodyFontSize))
                .foregroundStyle(.primary)
        }
        .padding(3 * .grid)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: theme.cornerRadius)
                .fill(Color.gray.opacity(0.14))
        )
    }

    @MainActor
    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await SunnyAPIClient.shared.fetchMessages(conversationId: conversation.id)
            messages = response.messages.sorted(by: { $0.timestamp < $1.timestamp })
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "E MMM d, h:mm a"
        return formatter
    }()
}

#Preview {
    NavigationStack {
        ConversationDetailView(
            conversation: ConversationItem(
                id: "conv-1",
                startedAt: .now,
                endedAt: nil,
                summary: "Discussed reminders, morning routine, and calendar planning.",
                sentiment: "neutral",
                topics: ["routine", "calendar"],
                status: "completed",
                durationMinutes: 12
            )
        )
    }
    .environment(SunnyTheme())
}
