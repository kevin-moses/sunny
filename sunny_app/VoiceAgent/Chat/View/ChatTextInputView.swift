import SwiftUI

/// A view that shows the chat input text field and send button.
struct ChatTextInputView: View {
    @Environment(ChatViewModel.self) private var chatViewModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @FocusState.Binding var keyboardFocus: Bool

    @State private var messageText = ""

    var body: some View {
        HStack(alignment: .bottom, spacing: 12) {
            textField()
            sendButton()
        }
        .frame(minHeight: 12 * .grid)
        .frame(maxWidth: horizontalSizeClass == .regular ? 128 * .grid : 92 * .grid)
        .background(.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 6 * .grid))
        .safeAreaPadding(.horizontal, 4 * .grid)
        .safeAreaPadding(.bottom, 4 * .grid)
    }

    private func textField() -> some View {
        TextField("message.placeholder", text: $messageText, axis: .vertical)
            .focused($keyboardFocus)
            .textFieldStyle(.plain)
            .lineLimit(3)
            .submitLabel(.send)
            .onSubmit {
                // will be called on Simulator with hardware keyboard
                Task {
                    await sendMessage()
                }
            }
            .onChange(of: messageText.last?.isNewline ?? false) { _, submit in
                // onSubmit won't be called by the submit key with software keybaord and .vertical TextField
                if submit {
                    Task {
                        await sendMessage()
                    }
                }
            }
            .foregroundStyle(.fg1)
            .padding()
    }

    private func sendButton() -> some View {
        AsyncButton(action: sendMessage) {
            Image(systemName: "arrow.up")
                .frame(width: 8 * .grid, height: 8 * .grid)
        }
        .padding([.bottom, .trailing], 3 * .grid)
        .disabled(messageText.isEmpty)
        .buttonStyle(RoundButtonStyle())
    }

    private func sendMessage() async {
        guard !messageText.isEmpty else { return }
        let text = messageText
        messageText = ""
        keyboardFocus = false
        await chatViewModel.sendMessage(text)
    }
}

#Preview {
    @FocusState var focus
    ChatTextInputView(keyboardFocus: $focus)
        .environment(ChatViewModel())
}
