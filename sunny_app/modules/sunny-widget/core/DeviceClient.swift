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
    case fresh(body: Data)
    case notModified
    case unauthorized
    case rateLimited(retryAfter: TimeInterval?)
    case failed
}

public enum PushStateOutcome: Equatable, Sendable {
    case answered(PushStateReply)
    case unauthorized
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

    public func timelineRequest(cachedVersion: String?, timeout: TimeInterval) -> URLRequest {
        var request = authorized(path: "device/timeline", timeout: timeout)
        request.httpMethod = "GET"
        if let cachedVersion { request.setValue("\"\(cachedVersion)\"", forHTTPHeaderField: "If-None-Match") }
        return request
    }

    public func request(for send: QueuedSend, at now: Date, timeout: TimeInterval) -> URLRequest {
        switch send {
        case .confirm(let press):
            return post(
                "device/confirm",
                ConfirmBody(
                    instanceId: press.instanceId,
                    pressedAgoMs: send.agoMs(at: now),
                    via: press.via.rawValue,
                    step: press.step,
                    pressId: press.id.uuidString
                ),
                timeout: timeout
            )
        case .undo(let undo):
            return post(
                "device/undo",
                UndoBody(instanceId: undo.instanceId, pressId: undo.pressId.uuidString, undoneAgoMs: send.agoMs(at: now)),
                timeout: timeout
            )
        }
    }

    private func post<Body: Encodable>(_ path: String, _ body: Body, timeout: TimeInterval) -> URLRequest {
        var request = authorized(path: path, timeout: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        request.httpBody = try? encoder.encode(body)
        return request
    }

    public func pushStateRequest(_ report: PushStateReport, timeout: TimeInterval) -> URLRequest {
        var request = authorized(path: "device/push-state", timeout: timeout)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? report.encoded()
        return request
    }

    public func reportPushState(_ report: PushStateReport, timeout: TimeInterval) async -> PushStateOutcome {
        guard let (data, response) = try? await transport.send(pushStateRequest(report, timeout: timeout)) else {
            return .failed
        }
        return Self.pushStateOutcome(status: response.statusCode, body: data)
    }

    public func fetchTimeline(cachedVersion: String?, timeout: TimeInterval) async -> FetchOutcome {
        let request = timelineRequest(cachedVersion: cachedVersion, timeout: timeout)
        guard let (data, response) = try? await transport.send(request) else {
            return .failed
        }
        return Self.fetchOutcome(status: response.statusCode, body: data, headers: response)
    }

    public func send(_ send: QueuedSend, at now: Date, timeout: TimeInterval) async -> SendOutcome {
        guard let (data, response) = try? await transport.send(request(for: send, at: now, timeout: timeout)) else {
            return .failed
        }
        return Self.sendOutcome(status: response.statusCode, body: data, headers: response)
    }

    static func fetchOutcome(status: Int, body: Data, headers: HTTPURLResponse) -> FetchOutcome {
        switch status {
        case 200: return .fresh(body: body)
        case 304: return .notModified
        case 401: return .unauthorized
        case 429: return .rateLimited(retryAfter: retryAfter(headers))
        default: return .failed
        }
    }

    static func sendOutcome(status: Int, body: Data, headers: HTTPURLResponse) -> SendOutcome {
        switch status {
        case 200: return .answered(serverAnswer(body))
        case 400: return .unreadable
        case 401: return .unauthorized
        case 429: return .rateLimited(retryAfter: retryAfter(headers))
        default: return .serverError(status: status)
        }
    }

    static func pushStateOutcome(status: Int, body: Data) -> PushStateOutcome {
        switch status {
        case 200: return .answered(PushStateReply.decode(body))
        case 401: return .unauthorized
        default: return .failed
        }
    }

    static func serverAnswer(_ body: Data) -> ServerAnswer {
        guard let answer = try? JSONDecoder().decode(AnswerBody.self, from: body) else {
            return ServerAnswer(status: .unrecognized(""))
        }
        return ServerAnswer(status: answerStatus(answer), answeredPresses: answer.answeredPresses)
    }

    private static func answerStatus(_ answer: AnswerBody) -> AnswerStatus {
        switch answer.status {
        case "confirmed": return .confirmed
        case "advanced": return .advanced
        case "undone": return .undone
        case "rejected": return .rejected(reason: answer.reason)
        case "too_late": return .tooLate
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
    let pressId: String
}

private struct UndoBody: Encodable {
    let instanceId: String
    let pressId: String
    let undoneAgoMs: Int
}

private struct AnswerBody: Decodable {
    let status: String
    let reason: String?
    let answeredPresses: Int?
}
