import SwiftUI

/// Scrollable list of past conversations, shown newest-first.
/// Each row displays date, duration, sentiment, and a truncated summary.
/// Tapping a row navigates to ConversationDetailView.
struct ConversationListView: View {
    @State private var conversations: [ConversationItem] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
            }

            if !isLoading {
                ForEach(conversations) { conversation in
                    NavigationLink {
                        ConversationDetailView(conversation: conversation)
                    } label: {
                        conversationRow(conversation)
                    }
                }
            }
        }
        .overlay {
            if isLoading, conversations.isEmpty {
                ProgressView("Loading conversations...")
            } else if !isLoading, errorMessage == nil, conversations.isEmpty {
                ContentUnavailableView {
                    Text("No conversations yet.")
                }
            }
        }
        .navigationTitle("Conversation Logs")
        .refreshable {
            await load()
        }
        .task {
            await load()
        }
    }

    /// Renders a single conversation row with date, duration, sentiment, and summary.
    ///
    /// purpose: Display summary info for one conversation in the list.
    /// @param item: (ConversationItem) the conversation to render
    private func conversationRow(_ item: ConversationItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(Self.dateFormatter.string(from: item.startedAt))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Spacer()
                Text(item.durationMinutes.map { "\($0) min" } ?? "—")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let sentiment = item.sentiment, !sentiment.isEmpty {
                Text(sentiment.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(rowSummaryText(item.summary))
                .font(.subheadline)
                .foregroundStyle(summaryColor(item.summary))
                .lineLimit(2)
        }
        .padding(.vertical, 4)
    }

    private func rowSummaryText(_ summary: String?) -> String {
        guard let trimmed = summary?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return "No summary"
        }
        return trimmed.count > 80 ? "\(trimmed.prefix(80))…" : trimmed
    }

    private func summaryColor(_ summary: String?) -> Color {
        guard let trimmed = summary?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return .secondary
        }
        return .primary
    }

    @MainActor
    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let response = try await SunnyAPIClient.shared.fetchConversations()
            conversations = response.conversations
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
        ConversationListView()
    }
    .environment(SunnyTheme())
}
