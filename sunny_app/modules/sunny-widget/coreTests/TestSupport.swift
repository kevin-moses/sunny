import Foundation
import XCTest

@testable import SunnyWidgetCore

enum Fixture {
    static let generatedAt = Date(timeIntervalSince1970: 1_795_098_600)
    static let newYork = TimeZone(identifier: "America/New_York")!
    static let unitedStates = Locale(identifier: "en_US")

    static func data(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    static func timeline(_ name: String) throws -> DeviceTimeline {
        try DeviceTimeline.decode(data(name))
    }

    static func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    static func object(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data(name)) as? [String: Any])
    }
}

func minutes(_ value: Double) -> TimeInterval { value * 60 }

func normalizedSpaces(_ text: String) -> String {
    text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
}

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date) { current = start }

    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func advance(_ interval: TimeInterval) {
        lock.lock()
        current = current.addingTimeInterval(interval)
        lock.unlock()
    }
}

final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?

    init(_ token: String?) { self.token = token }

    func read() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return token
    }

    func write(_ token: String) throws {
        lock.lock()
        self.token = token
        lock.unlock()
    }

    func remove(ifEqualTo expected: String?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard token != nil, expected == nil || expected == token else { return false }
        token = nil
        return true
    }
}

final class MemorySiteStore: SiteStore, @unchecked Sendable {
    private let lock = NSLock()
    private var url: URL?

    init(_ url: URL?) { self.url = url }

    func read() -> URL? {
        lock.lock()
        defer { lock.unlock() }
        return url
    }

    func write(_ url: URL) {
        lock.lock()
        self.url = url
        lock.unlock()
    }

    func remove() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard url != nil else { return false }
        url = nil
        return true
    }
}

struct RecordedRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data?

    var json: [String: Any]? {
        body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }
}

final class FakeTransport: HTTPTransport, @unchecked Sendable {
    typealias Reply = (status: Int, body: Data, headers: [String: String])

    private let lock = NSLock()
    private var timelineReplies: [Reply?] = []
    private var confirmReplies: [Reply?] = []
    private var pushStateReplies: [Reply?] = []
    private(set) var requests: [RecordedRequest] = []

    func queueTimeline(_ status: Int, body: Data = Data(), headers: [String: String] = [:]) {
        lock.lock()
        timelineReplies.append((status, body, headers))
        lock.unlock()
    }

    func queueTimelineFailure() {
        lock.lock()
        timelineReplies.append(nil)
        lock.unlock()
    }

    func queueConfirm(_ status: Int, body: Data = Data(), headers: [String: String] = [:]) {
        lock.lock()
        confirmReplies.append((status, body, headers))
        lock.unlock()
    }

    func queueConfirmFailure() {
        lock.lock()
        confirmReplies.append(nil)
        lock.unlock()
    }

    func queuePushState(_ status: Int, body: Data = Data()) {
        lock.lock()
        pushStateReplies.append((status, body, [:]))
        lock.unlock()
    }

    var pushStateRequests: [RecordedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests.filter { $0.path == "/device/push-state" }
    }

    var confirmBodies: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return requests.filter { $0.path == "/device/confirm" }.compactMap(\.json)
    }

    var timelineRequests: [RecordedRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests.filter { $0.path == "/device/timeline" }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = try XCTUnwrap(request.url)
        let reply: Reply? = try {
            lock.lock()
            defer { lock.unlock() }
            requests.append(
                RecordedRequest(
                    method: request.httpMethod ?? "GET",
                    path: url.path,
                    headers: request.allHTTPHeaderFields ?? [:],
                    body: request.httpBody
                )
            )
            if url.path == "/device/confirm" {
                guard !confirmReplies.isEmpty else { return nil }
                return confirmReplies.removeFirst()
            }
            if url.path == "/device/push-state" {
                guard !pushStateReplies.isEmpty else { return nil }
                return pushStateReplies.removeFirst()
            }
            guard !timelineReplies.isEmpty else { return nil }
            return timelineReplies.removeFirst()
        }()
        guard let reply else { throw URLError(.notConnectedToInternet) }
        let response = try XCTUnwrap(
            HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)
        )
        return (reply.body, response)
    }
}

func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("SunnyWidgetTests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
