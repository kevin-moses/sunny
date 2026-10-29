// Services/SunnyBackend.swift
//
// Purpose: The senior devices' connection to Sunny's Supabase backend. A device signs in
// anonymously with Supabase Auth (no account for the senior), redeems a caregiver's
// join code once to pair with a household, and then calls RPCs (get_day_view, ...) and
// Edge Functions (livekit-token) as that paired device; row level security limits it
// to its household. The session is kept in the Keychain and refreshed before it
// expires (one refresh at a time; a 401 forces one refresh and a retry); the pairing
// (household and device kind) is kept in UserDefaults. Losing the pairing (removed by a
// caregiver, unpaired in dev settings, or a session Auth definitively rejects; never a
// network error) posts .sunnyPairingLost so the app returns to the pairing screen.
// The backend URL and publishable key come from Info.plist (SunnySupabaseURL,
// SunnySupabaseKey), set in VoiceAgent.xcconfig and overridable in .env.xcconfig.
//
// Last modified: 2026-10-27

import Foundation
import Security

/// What kind of senior device this is, as recorded by the join code.
enum DeviceKind: String, Codable {
    case seniorPhone = "senior_phone"
    case homeDisplay = "home_display"
}

/// This device's pairing with a household.
struct PairedDevice: Codable, Equatable {
    let householdId: String
    let kind: DeviceKind
}

extension Notification.Name {
    /// Posted when this device's pairing is removed; the app shows the pairing screen.
    static let sunnyPairingLost = Notification.Name("sunnyPairingLost")
}

/// Errors from the Sunny backend, with messages safe to show.
enum SunnyBackendError: LocalizedError {
    case notConfigured
    case notPaired
    case server(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            "Sunny's server address is not set up in this build."
        case .notPaired:
            "This device is not connected to a family yet."
        case let .server(_, message):
            message
        }
    }
}

/// Async client for Supabase Auth, PostgREST RPCs and Edge Functions.
/// Use `SunnyBackend.shared`.
actor SunnyBackend {
    static let shared = SunnyBackend()

    private struct Session: Codable {
        let accessToken: String
        let refreshToken: String
        let expiresAt: Date
        let userId: String
    }

    private let baseURL: URL?
    private let apiKey: String
    private var session: Session?

    private static let keychainAccount = "sunny.supabase.session"
    private static let pairingKey = "sunny.pairedDevice"

    /// ISO 8601 parsers for Postgres timestamps, without and with fractional seconds.
    /// Never mutated after creation, and ISO8601DateFormatter parsing is thread-safe.
    private nonisolated(unsafe) static let isoFormatters: [ISO8601DateFormatter] = ([
        [.withInternetDateTime], [.withInternetDateTime, .withFractionalSeconds],
    ] as [ISO8601DateFormatter.Options]).map { options in
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = options
        return formatter
    }

    /// Decodes Postgres and Edge Function JSON for every client in the app: snake_case
    /// keys, timestamps with or without fractional seconds.
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            for formatter in isoFormatters {
                if let date = formatter.date(from: value) { return date }
            }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(value)")
        }
        return decoder
    }()

    /// purpose: Read the backend address and key from Info.plist and restore a saved session.
    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let url = (info["SunnySupabaseURL"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
        baseURL = url
        apiKey = info["SunnySupabaseKey"] as? String ?? ""
        session = Self.loadSession()
    }

    // MARK: - Pairing

    /// The household this device is paired with, if any.
    nonisolated var pairedDevice: PairedDevice? {
        guard let data = UserDefaults.standard.data(forKey: Self.pairingKey) else { return nil }
        return try? JSONDecoder().decode(PairedDevice.self, from: data)
    }

    /// purpose: Pair this device with a household by redeeming a caregiver's join code:
    ///          sign in anonymously if needed, redeem the code, then read back the device row.
    /// @param code: (String) The 8-character join code (case and spaces ignored).
    /// @return PairedDevice for the household.
    func pair(code: String) async throws -> PairedDevice {
        let cleaned = code.uppercased().filter { $0.isLetter || $0.isNumber }
        _ = try await validAccessToken()
        let _: String = try await rpc("redeem_join_code", ["p_code": cleaned])
        let userId = session?.userId ?? ""
        let devices: [PairedDevice] = try await request(
            "rest/v1/devices", query: "user_id=eq.\(userId)&select=household_id,kind"
        )
        guard let device = devices.first else { throw SunnyBackendError.notPaired }
        try UserDefaults.standard.set(JSONEncoder().encode(device), forKey: Self.pairingKey)
        return device
    }

    /// purpose: Forget the pairing and the session (the caregiver can pair the device
    ///          again) and tell the app to show the pairing screen.
    func unpair() {
        session = nil
        Self.deleteSession()
        Self.dropPairing()
    }

    /// purpose: Forget the pairing and tell the app (on the main actor) to show pairing.
    private static func dropPairing() {
        UserDefaults.standard.removeObject(forKey: pairingKey)
        Task { @MainActor in NotificationCenter.default.post(name: .sunnyPairingLost, object: nil) }
    }

    // MARK: - Calls

    /// purpose: Call a Postgres RPC as this device.
    /// @param name: (String) RPC name, e.g. "get_day_view".
    /// @param params: ([String: String]) Named arguments.
    /// @return The decoded result.
    func rpc<T: Decodable>(_ name: String, _ params: [String: String]) async throws -> T {
        try await request("rest/v1/rpc/\(name)", body: JSONEncoder().encode(params))
    }

    /// purpose: Call an Edge Function as this device and unwrap its { data, error } envelope.
    /// @param name: (String) Function name, e.g. "livekit-token".
    /// @param body: (Encodable) JSON body.
    /// @return The decoded `data` payload.
    func invoke<T: Decodable>(_ name: String, body: some Encodable) async throws -> T {
        let envelope: APIResponse<T> = try await request("functions/v1/\(name)", body: JSONEncoder().encode(body))
        if let error = envelope.error { throw SunnyBackendError.server(status: 400, message: error.message) }
        guard let data = envelope.data else { throw SunnyBackendError.server(status: 500, message: "Empty response") }
        return data
    }

    /// purpose: Build and send one request to the backend: GET, or POST with a JSON body.
    ///          An authorized request the server rejects with 401 (for example a token the
    ///          device clock thought was still valid) is retried once with a fresh token.
    /// @param path: (String) Path under the project URL, e.g. "rest/v1/rpc/get_day_view".
    /// @param query: (String?) Already-encoded query string.
    /// @param body: (Data?) JSON body; makes the request a POST.
    /// @param authorized: (Bool) Send this device's access token (false for Auth calls).
    /// @return The decoded response.
    private func request<T: Decodable>(
        _ path: String, query: String? = nil, body: Data? = nil, authorized: Bool = true
    ) async throws -> T {
        guard let baseURL,
              var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
        else { throw SunnyBackendError.notConfigured }
        components.percentEncodedQuery = query
        guard let url = components.url else { throw SunnyBackendError.notConfigured }
        var request = URLRequest(url: url)
        if let body {
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        request.setValue(apiKey, forHTTPHeaderField: "apikey")
        guard authorized else { return try await perform(request) }

        try await request.setValue("Bearer \(validAccessToken())", forHTTPHeaderField: "Authorization")
        do {
            return try await perform(request)
        } catch SunnyBackendError.server(status: 401, _) {
            try await request.setValue("Bearer \(validAccessToken(forceRefresh: true))", forHTTPHeaderField: "Authorization")
            return try await perform(request)
        }
    }

    /// purpose: Send a request and decode a 2xx JSON response.
    /// @param request: (URLRequest) The prepared request.
    /// @return The decoded response.
    /// @raises SunnyBackendError.server with the status and the server's message otherwise.
    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200 ..< 300).contains(status) else {
            throw SunnyBackendError.server(status: status, message: Self.errorMessage(data) ?? "Request failed (\(status))")
        }
        return try Self.decoder.decode(T.self, from: data)
    }

    /// purpose: Pull a readable message out of a PostgREST, Auth or Edge Function error body.
    /// @param data: (Data) Response body.
    /// @return The message, if one is present.
    private static func errorMessage(_ data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let error = json["error"] as? [String: Any], let message = error["message"] as? String { return message }
        return json["message"] as? String ?? json["msg"] as? String ?? json["error_description"] as? String
    }

    // MARK: - Auth

    private struct AuthResponse: Decodable {
        struct User: Decodable { let id: String }
        let accessToken: String
        let refreshToken: String
        let expiresIn: Double
        let user: User
    }

    /// The token refresh or sign-up in progress, shared so concurrent callers (the day view
    /// and a Talk session) never spend the same rotating refresh token twice.
    private var pendingAuth: Task<String, Error>?

    /// purpose: Return an access token, refreshing or signing in anonymously as needed.
    /// @param forceRefresh: (Bool) Refresh even if the token looks valid (after a 401).
    /// @return A JWT valid for at least another minute.
    private func validAccessToken(forceRefresh: Bool = false) async throws -> String {
        if !forceRefresh, let session, session.expiresAt.timeIntervalSinceNow > 60 {
            return session.accessToken
        }
        if let pendingAuth { return try await pendingAuth.value }
        let task = Task { try await self.refreshOrSignUp() }
        pendingAuth = task
        defer { pendingAuth = nil }
        return try await task.value
    }

    /// purpose: Refresh the session, or start a new anonymous one when there is none or
    ///          Auth definitively rejects the refresh token (400/401). Network errors and
    ///          server errors are rethrown, so a blip never costs the device its pairing.
    /// @return A fresh access token.
    private func refreshOrSignUp() async throws -> String {
        if let session {
            do {
                return try await store(request(
                    "auth/v1/token",
                    query: "grant_type=refresh_token",
                    body: JSONEncoder().encode(["refresh_token": session.refreshToken]),
                    authorized: false
                ))
            } catch let SunnyBackendError.server(status, _) where status == 400 || status == 401 {
                // The session is gone for good; a new anonymous user is not in the household.
                if pairedDevice != nil { Self.dropPairing() }
            }
        }
        return try await store(request("auth/v1/signup", body: Data("{}".utf8), authorized: false))
    }

    /// purpose: Keep a new session in memory and the Keychain.
    /// @param auth: (AuthResponse) Tokens from Supabase Auth.
    /// @return The new access token.
    private func store(_ auth: AuthResponse) -> String {
        let new = Session(
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken,
            expiresAt: Date().addingTimeInterval(auth.expiresIn),
            userId: auth.user.id
        )
        session = new
        Self.saveSession(new)
        return new.accessToken
    }

    // MARK: - Keychain

    /// The Keychain item holding the session (this device only, never in backups).
    private static var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: keychainAccount]
    }

    /// purpose: Read the saved session.
    /// @return The session, or nil when none is saved.
    private static func loadSession() -> Session? {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    /// purpose: Save the session, replacing any earlier one.
    /// @param session: (Session) The session to keep.
    private static func saveSession(_ session: Session) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        deleteSession()
        var query = keychainQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    /// purpose: Delete the saved session.
    private static func deleteSession() {
        SecItemDelete(keychainQuery as CFDictionary)
    }
}
