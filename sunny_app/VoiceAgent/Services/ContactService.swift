// Services/ContactService.swift
//
// Purpose: Client-side contact search using CNContactStore. Fetches all contacts and
// filters by name match. Called by AppViewModel's "findContact" RPC handler.
// Logs authorization status and result counts via SunnyLogger for cross-side debugging.
//
// Last modified: 2026-03-03

@preconcurrency import Contacts
import Foundation

/// Service for managing contacts and contact searches.
/// Provides client-side contact management while keeping contact data private.
final class ContactService: ObservableObject, Sendable {
    init() {}

    /// Find contacts matching a search query (name, phone, etc.)
    /// @param query: The search string to match against contact names
    /// @return: Array of contact results with name and phone number
    func findContacts(query: String) async throws -> [[String: String]] {
        // Perform contacts access off main thread
        try await Task.detached {
            let contactStore = CNContactStore()

            // Request authorization if needed
            let authStatus = CNContactStore.authorizationStatus(for: .contacts)
            SunnyLogger.shared.debug("Contacts", "Authorization status: \(authStatus.rawValue)")

            if authStatus == .denied || authStatus == .restricted {
                throw ContactError.accessDenied
            }

            // Request access if not determined
            if authStatus == .notDetermined {
                let granted = try await contactStore.requestAccess(for: .contacts)
                if !granted {
                    throw ContactError.accessDenied
                }
            }

            // Keys to fetch from contacts
            let keysToFetch: [CNKeyDescriptor] = [
                CNContactGivenNameKey as CNKeyDescriptor,
                CNContactFamilyNameKey as CNKeyDescriptor,
                CNContactPhoneNumbersKey as CNKeyDescriptor,
                CNContactIdentifierKey as CNKeyDescriptor,
            ]

            var contacts: [CNContact] = []
            let request = CNContactFetchRequest(keysToFetch: keysToFetch)

            // Fetch all contacts first, then filter
            try contactStore.enumerateContacts(with: request) { contact, _ in
                let fullName = "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces)

                // Match against full name (case insensitive)
                if fullName.lowercased().contains(query.lowercased()) {
                    contacts.append(contact)
                }
            }

            // Convert to simplified format for RPC response
            let results = contacts.compactMap { contact -> [String: String]? in
                guard let phoneNumber = contact.phoneNumbers.first?.value.stringValue else {
                    return nil // Skip contacts without phone numbers
                }

                let fullName = "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces)

                return [
                    "id": contact.identifier,
                    "name": fullName.isEmpty ? "Unknown" : fullName,
                    "phone": phoneNumber,
                ]
            }

            SunnyLogger.shared.info("Contacts", "Found \(results.count) matching contacts",
                                    metadata: ["query": query])
            return results
        }.value
    }
}

/// Errors that can occur when working with contacts
enum ContactError: LocalizedError {
    case accessDenied
    case contactNotFound
    case noPhoneNumber

    var errorDescription: String? {
        switch self {
        case .accessDenied:
            "Access to contacts was denied"
        case .contactNotFound:
            "Contact not found"
        case .noPhoneNumber:
            "Contact has no phone number"
        }
    }
}
