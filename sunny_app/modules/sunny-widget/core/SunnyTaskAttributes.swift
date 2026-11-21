import Foundation

#if os(iOS)
import ActivityKit
#endif

public struct SunnyTaskAttributes: Codable, Hashable, Sendable {
    public typealias ContentState = TaskActivityState

    public let activityKey: String
    public let instanceId: String
    public let receiptMs: Double
    public let timeZone: String

    public init(activityKey: String, instanceId: String, receiptMs: Double, timeZone: String) {
        self.activityKey = activityKey
        self.instanceId = instanceId
        self.receiptMs = receiptMs
        self.timeZone = timeZone
    }

    public var receiptDuration: TimeInterval { receiptMs / 1000 }

    public var householdTimeZone: TimeZone { TimeZone(identifier: timeZone) ?? .autoupdatingCurrent }
}

#if os(iOS)
extension SunnyTaskAttributes: ActivityAttributes {}
#endif

public struct TaskActivityState: Codable, Hashable, Sendable {
    public var card: TaskCard
    public var nextSteps: [String]
    public var closed: ActivityClosed?

    public init(card: TaskCard, nextSteps: [String], closed: ActivityClosed?) {
        self.card = card
        self.nextSteps = nextSteps
        self.closed = closed
    }

    private enum CodingKeys: String, CodingKey {
        case card, nextSteps, closed
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(card, forKey: .card)
        try container.encode(nextSteps, forKey: .nextSteps)
        try container.encode(closed, forKey: .closed)
    }
}

public struct ActivityClosed: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case done
        case over
    }

    public let kind: Kind
    public let at: Date

    public init(kind: Kind, at: Date) {
        self.kind = kind
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case kind, at
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(Kind.self, forKey: .kind)
        at = date(fromEpochMs: try container.decode(Double.self, forKey: .at))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(epochMs(at), forKey: .at)
    }
}
