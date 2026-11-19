import Foundation

public enum ReportedActivityState: String, Codable, Sendable {
    case active
    case stale
    case ended
    case dismissed
}

public struct StartTokenReport: Equatable, Sendable {
    public let token: String?
    public let enabled: Bool

    public init(token: String?, enabled: Bool) {
        self.token = token
        self.enabled = enabled
    }
}

public struct ActivityReport: Equatable, Sendable {
    public let key: String
    public let token: String?
    public let state: ReportedActivityState

    public init(key: String, token: String?, state: ReportedActivityState) {
        self.key = key
        self.token = token
        self.state = state
    }
}

public struct WidgetPushReport: Codable, Equatable, Sendable {
    public let token: String?

    public init(token: String?) {
        self.token = token
    }

    private enum CodingKeys: String, CodingKey {
        case token
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(token, forKey: .token)
    }
}

public struct PushStateReport: Encodable, Equatable, Sendable {
    public let liveActivityStart: StartTokenReport?
    public let activities: [ActivityReport]?
    public let widgetPush: WidgetPushReport?

    public init(liveActivityStart: StartTokenReport?, activities: [ActivityReport]?, widgetPush: WidgetPushReport?) {
        self.liveActivityStart = liveActivityStart
        self.activities = activities
        self.widgetPush = widgetPush
    }

    public static let maxActivities = 8

    public static let cleared = PushStateReport(
        liveActivityStart: StartTokenReport(token: nil, enabled: false),
        activities: [],
        widgetPush: WidgetPushReport(token: nil)
    )

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try encoder.encode(self)
    }
}

extension StartTokenReport: Encodable {
    private enum CodingKeys: String, CodingKey {
        case token, enabled
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(token, forKey: .token)
        try container.encode(enabled, forKey: .enabled)
    }
}

extension ActivityReport: Encodable {
    private enum CodingKeys: String, CodingKey {
        case key, token, state
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(key, forKey: .key)
        try container.encode(token, forKey: .token)
        try container.encode(state, forKey: .state)
    }
}

public enum ActivityDirective: Equatable, Sendable {
    case update(key: String, state: TaskActivityState, staleAt: Date)
    case end(key: String, state: TaskActivityState?)

    public var key: String {
        switch self {
        case .update(let key, _, _), .end(let key, _):
            return key
        }
    }
}

public struct PushStateReply: Equatable, Sendable {
    public let directives: [ActivityDirective]

    public init(directives: [ActivityDirective]) {
        self.directives = directives
    }

    public static func decode(_ data: Data) -> PushStateReply {
        guard let wire = try? JSONDecoder().decode(WireReply.self, from: data) else {
            return PushStateReply(directives: [])
        }
        return PushStateReply(directives: wire.activities.compactMap(\.directive))
    }
}

private struct WireReply: Decodable {
    let activities: [WireDirective]
}

private struct WireDirective: Decodable {
    let directive: ActivityDirective?

    private enum CodingKeys: String, CodingKey {
        case key, directive, content, staleAt
    }

    init(from decoder: Decoder) throws {
        guard
            let container = try? decoder.container(keyedBy: CodingKeys.self),
            let key = try? container.decode(String.self, forKey: .key),
            let kind = try? container.decode(String.self, forKey: .directive)
        else {
            directive = nil
            return
        }
        let state = try? container.decode(TaskActivityState.self, forKey: .content)
        switch kind {
        case "update":
            guard let state, let staleAt = try? container.decode(Double.self, forKey: .staleAt) else {
                directive = nil
                return
            }
            directive = .update(key: key, state: state, staleAt: date(fromEpochMs: staleAt))
        case "end":
            directive = .end(key: key, state: state)
        default:
            directive = nil
        }
    }
}

public enum RefreshPush {
    public static func matches(_ userInfo: [AnyHashable: Any]) -> Bool {
        guard let aps = userInfo["aps"] as? [AnyHashable: Any] else { return false }
        return (aps["content-available"] as? Int) == 1
    }
}

extension Data {
    public var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
