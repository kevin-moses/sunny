import Foundation
import MessageUI
import UIKit

/// Service for sending messages using MessageUI framework
/// This service handles composing and sending SMS messages to contacts
@MainActor
final class MessageService: NSObject, ObservableObject {
    /// Send a message to a contact
    /// @param contactId: The contact identifier (currently unused but available for future use)
    /// @param phoneNumber: The recipient's phone number
    /// @param message: The message content to send
    /// @return: Result message indicating success or failure
    func sendMessage(contactId _: String, phoneNumber: String, message: String) throws -> String {
        // Check if device can send text messages
        guard MFMessageComposeViewController.canSendText() else {
            throw MessageError.deviceCannotSendMessages
        }

        // Validate inputs
        guard !phoneNumber.isEmpty else {
            throw MessageError.invalidPhoneNumber
        }

        guard !message.isEmpty else {
            throw MessageError.emptyMessage
        }

        print("[Messages] Preparing to send message to \(phoneNumber): '\(message)'")

        // Create the message composer
        let messageComposer = MFMessageComposeViewController()
        messageComposer.recipients = [phoneNumber]
        messageComposer.body = message
        messageComposer.messageComposeDelegate = self

        // Present the message composer from the root view controller
        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first,
           let rootViewController = window.rootViewController
        {
            rootViewController.present(messageComposer, animated: true)
        }

        return "Message composer opened for \(phoneNumber)"
    }
}

// MARK: - MFMessageComposeViewControllerDelegate

extension MessageService: MFMessageComposeViewControllerDelegate {
    nonisolated func messageComposeViewController(
        _ controller: MFMessageComposeViewController,
        didFinishWith result: MessageComposeResult
    ) {
        Task { @MainActor in
            controller.dismiss(animated: true) {
                switch result {
                case .cancelled:
                    print("[Messages] Message composition cancelled")
                case .sent:
                    print("[Messages] Message sent successfully")
                case .failed:
                    print("[Messages] Message sending failed")
                @unknown default:
                    print("[Messages] Unknown message result")
                }
            }
        }
    }
}

/// Errors that can occur when sending messages
enum MessageError: LocalizedError {
    case deviceCannotSendMessages
    case invalidPhoneNumber
    case emptyMessage
    case sendingFailed

    var errorDescription: String? {
        switch self {
        case .deviceCannotSendMessages:
            "This device cannot send text messages"
        case .invalidPhoneNumber:
            "Invalid phone number provided"
        case .emptyMessage:
            "Message content cannot be empty"
        case .sendingFailed:
            "Failed to send message"
        }
    }
}
