// Services/SunnyAPIClient.swift
//
// HTTP client for Sunny's Supabase Edge Function REST API.
// Handles: conversation history fetching (DEV logs), FCM device token registration,
// and LiveKit token fetching with optional notification session context.
//
// Auth: Bearer token is hardcoded to the test user UUID for MVP.
// TODO: Phase 3: replace with real JWT once auth is implemented.
//
// All endpoints follow the { data: T, error: null } response envelope.
// Dates are decoded from ISO-8601 strings (with or without fractional seconds).
// POST requests with a body must pass Data via the body parameter of request(_:method:body:).

import Foundation

/// Async HTTP client for the Sunny backend API.
/// Use `SunnyAPIClient.shared` for all calls.
actor SunnyAPIClient {
    /// Singleton instance.
    static let shared = SunnyAPIClient()

    private let baseURL = URL(string: "https://rlihlcgyjqyzkpzijtsp.supabase.co/functions/v1")!
    private let testUserId = "00000000-0000-0000-0000-000000000001"

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]

            if let date = fractional.date(from: value) {
                return date
            }
            if let date = standard.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(value)"
            )
        }
        return decoder
    }()

    /// Fetches a paginated list of conversations for the current user, newest first.
    ///
    /// purpose: Load conversation history for the DEV Logs tab.
    /// @param limit: (Int) max results per page, default 20
    /// @param offset: (Int) pagination offset, default 0
    /// @return ConversationsResponse with conversations array and total count
    func fetchConversations(limit: Int = 20, offset: Int = 0) async throws -> ConversationsResponse {
        var components = URLComponents(
            url: baseURL.appending(path: "get-conversations"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "limit", value: "\(limit)"),
            URLQueryItem(name: "offset", value: "\(offset)"),
        ]
        guard let url = components?.url else {
            throw SunnyAPIError.invalidURL
        }
        return try await request(url: url, method: "GET")
    }

    /// Fetches all messages and metadata for a specific conversation.
    ///
    /// purpose: Load the full transcript for ConversationDetailView.
    /// @param conversationId: (String) UUID of the target conversation
    /// @return MessagesResponse with messages array and conversation metadata
    func fetchMessages(conversationId: String) async throws -> MessagesResponse {
        var components = URLComponents(
            url: baseURL.appending(path: "get-messages"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "conversation_id", value: conversationId)]
        guard let url = components?.url else {
            throw SunnyAPIError.invalidURL
        }
        return try await request(url: url, method: "GET")
    }

    // IOS-4 scope does not require these endpoints yet.
    func fetchUserProfile() async throws {}
    func fetchReminders() async throws {}

    /// Registers the device's FCM token with the backend so push notifications can be sent.
    ///
    /// purpose: POST the FCM registration token to save-device-token so the server can
    ///          address push notifications to this device. Safe to call on every token
    ///          refresh — the edge function upserts on (user_id, platform).
    /// @param token: (String) FCM registration token from FirebaseMessaging
    func saveDeviceToken(_ token: String) async throws {
        let url = baseURL.appending(path: "save-device-token")
        let body = try JSONEncoder().encode(DeviceTokenRequest(token: token, platform: "ios"))
        let _: DeviceTokenResponse = try await request(url: url, method: "POST", body: body)
    }

    /// Fetches LiveKit connection details from the Supabase edge function, embedding
    /// optional notification session context in the participant metadata.
    ///
    /// purpose: Call livekit-token to obtain a signed JWT and server URL. When a
    ///          NotificationContext is supplied the trigger, reminderId, and adherenceLogId
    ///          are embedded in participant metadata so the agent can greet the user in context.
    /// @param roomName: (String) LiveKit room identifier
    /// @param participantName: (String) Participant display name for this session
    /// @param notificationContext: (NotificationContext?) optional reminder tap context
    /// @return TokenService.ConnectionDetails with serverUrl and participantToken
    func fetchLiveKitToken(
        roomName: String,
        participantName: String,
        notificationContext: NotificationContext? = nil
    ) async throws -> TokenService.ConnectionDetails {
        let url = baseURL.appending(path: "livekit-token")
        let requestBody = LiveKitTokenRequest(
            roomName: roomName,
            participantName: participantName,
            userId: testUserId,
            trigger: notificationContext?.trigger,
            reminderId: notificationContext?.reminderId,
            adherenceLogId: notificationContext?.adherenceLogId
        )
        let body = try JSONEncoder().encode(requestBody)
        return try await request(url: url, method: "POST", body: body)
    }

    /// Generic HTTP request helper that decodes the API response envelope.
    ///
    /// purpose: Execute a request, unwrap { data, error } envelope, and return typed payload.
    ///          When body is provided the request is sent as application/json POST body.
    /// @param url: (URL) fully-formed request URL
    /// @param method: (String) HTTP method string e.g. "GET" or "POST"
    /// @param body: (Data?) optional JSON-encoded request body; sets Content-Type automatically
    /// @return decoded payload of type T
    private func request<T: Decodable>(url: URL, method: String, body: Data? = nil) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(testUserId)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SunnyAPIError.invalidResponse
        }

        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let body = String(data: data, encoding: .utf8)
            throw SunnyAPIError.httpError(statusCode: httpResponse.statusCode, body: body)
        }

        let wrapped = try decoder.decode(APIResponse<T>.self, from: data)
        if let apiError = wrapped.error {
            throw SunnyAPIError.apiError(apiError)
        }
        guard let payload = wrapped.data else {
            throw SunnyAPIError.emptyData
        }
        return payload
    }
}

enum SunnyAPIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int, body: String?)
    case apiError(APIError)
    case emptyData

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid API URL"
        case .invalidResponse:
            return "Invalid API response"
        case let .httpError(statusCode, body):
            if let body, !body.isEmpty {
                return "HTTP \(statusCode): \(body)"
            }
            return "HTTP \(statusCode)"
        case let .apiError(error):
            if let code = error.code, !code.isEmpty {
                return "\(error.message) (\(code))"
            }
            return error.message
        case .emptyData:
            return "API returned no data"
        }
    }
}

struct APIResponse<T: Decodable>: Decodable {
    let data: T?
    let error: APIError?
}

struct APIError: Codable {
    let message: String
    let code: String?
}

struct ConversationItem: Codable, Identifiable {
    let id: String
    let startedAt: Date
    let endedAt: Date?
    let summary: String?
    let sentiment: String?
    let topics: [String]?
    let status: String
    let durationMinutes: Int?
}

struct ConversationsResponse: Codable {
    let conversations: [ConversationItem]
    let total: Int
}

struct MessageItem: Codable, Identifiable {
    let id: String
    let conversationId: String
    let role: String
    let content: String
    let timestamp: Date
}

struct ConversationMetadata: Codable {
    let summary: String?
    let sentiment: String?
    let topics: [String]?
}

struct MessagesResponse: Codable {
    let messages: [MessageItem]
    let conversation: ConversationMetadata
}

private struct DeviceTokenRequest: Encodable {
    let token: String
    let platform: String
}

struct DeviceTokenResponse: Decodable {
    let saved: Bool
}

private struct LiveKitTokenRequest: Encodable {
    let roomName: String
    let participantName: String
    let userId: String
    let trigger: String?
    let reminderId: String?
    let adherenceLogId: String?
}
