import Foundation

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

public enum FetchOutcome: Equatable, Sendable {
    case fresh(body: Data, etag: String?)
    case notModified
    case unauthorized
    case rateLimited(retryAfter: TimeInterval?)
    case failed
}

public struct DeviceClient: Sendable {
    let siteURL: URL
    let token: String
    let transport: HTTPTransport

    public init(siteURL: URL, token: String, transport: HTTPTransport) {
        self.siteURL = siteURL
        self.token = token
        self.transport = transport
    }

    public func timelineRequest(etag: String?, timeout: TimeInterval) -> URLRequest {
        var request = authorized(path: "device/timeline", timeout: timeout)
        request.httpMethod = "GET"
        if let etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        return request
    }

    public func confirmRequest(_ press: Press, at now: Date, timeout: TimeInterval) -> URLRequest {
        var request = authorized(path: "device/confirm", timeout: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = ConfirmBody(
            instanceId: press.instanceId,
            pressedAgoMs: press.pressedAgoMs(at: now),
            via: press.via.rawValue,
            step: press.step
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        request.httpBody = try? encoder.encode(body)
        return request
    }

    public func fetchTimeline(etag: String?, timeout: TimeInterval) async -> FetchOutcome {
        guard let (data, response) = try? await transport.send(timelineRequest(etag: etag, timeout: timeout)) else {
            return .failed
        }
        return Self.fetchOutcome(status: response.statusCode, body: data, headers: response)
    }

    public func confirm(_ press: Press, at now: Date, timeout: TimeInterval) async -> ConfirmOutcome {
        guard let (data, response) = try? await transport.send(confirmRequest(press, at: now, timeout: timeout)) else {
            return .failed
        }
        return Self.confirmOutcome(status: response.statusCode, body: data, headers: response)
    }

    static func fetchOutcome(status: Int, body: Data, headers: HTTPURLResponse) -> FetchOutcome {
        switch status {
        case 200: return .fresh(body: body, etag: headers.value(forHTTPHeaderField: "ETag"))
        case 304: return .notModified
        case 401: return .unauthorized
        case 429: return .rateLimited(retryAfter: retryAfter(headers))
        default: return .failed
        }
    }

    static func confirmOutcome(status: Int, body: Data, headers: HTTPURLResponse) -> ConfirmOutcome {
        switch status {
        case 200: return .answered(confirmStatus(body))
        case 400: return .unreadable
        case 401: return .unauthorized
        case 429: return .rateLimited(retryAfter: retryAfter(headers))
        default: return .failed
        }
    }

    static func confirmStatus(_ body: Data) -> ConfirmStatus {
        guard let answer = try? JSONDecoder().decode(ConfirmAnswer.self, from: body) else {
            return .unrecognized("")
        }
        switch answer.status {
        case "confirmed": return .confirmed
        case "advanced": return .advanced
        case "rejected": return .rejected(reason: answer.reason)
        default: return .unrecognized(answer.status)
        }
    }

    static func retryAfter(_ response: HTTPURLResponse) -> TimeInterval? {
        guard let value = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
        return TimeInterval(value.trimmingCharacters(in: .whitespaces))
    }

    private func authorized(path: String, timeout: TimeInterval) -> URLRequest {
        var request = URLRequest(
            url: siteURL.appendingPathComponent(path),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: timeout
        )
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
}

private struct ConfirmBody: Encodable {
    let instanceId: String
    let pressedAgoMs: Int
    let via: String
    let step: Int
}

private struct ConfirmAnswer: Decodable {
    let status: String
    let reason: String?
}
