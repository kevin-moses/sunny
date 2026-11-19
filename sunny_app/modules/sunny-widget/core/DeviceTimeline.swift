import Foundation

public struct PressKey: Hashable, Codable, Sendable {
    public let instanceId: String
    public let step: Int

    public init(instanceId: String, step: Int) {
        self.instanceId = instanceId
        self.step = step
    }
}

public enum TaskIcon: String, Codable, Sendable {
    case pills
    case calendar
    case checklist
    case bell
    case clock

    public static func symbolName(_ icon: TaskIcon?) -> String {
        switch icon ?? .clock {
        case .pills: return "pill"
        case .calendar: return "calendar"
        case .checklist: return "checklist"
        case .bell: return "bell"
        case .clock: return "clock"
        }
    }
}

public struct TaskCard: Hashable, Sendable {
    public let instanceId: String
    public let step: Int
    public let stepCount: Int
    public let stepText: String?
    public let label: String
    public let sentence: String?
    public let detail: String?
    public let startsAt: Date
    public let endsAt: Date
    public let icon: TaskIcon?

    public var key: PressKey { PressKey(instanceId: instanceId, step: step) }

    public var isLastStep: Bool { step + 1 >= stepCount }

    func advanced(stepText nextText: String?) -> TaskCard {
        TaskCard(
            instanceId: instanceId,
            step: step + 1,
            stepCount: stepCount,
            stepText: presentText(nextText),
            label: label,
            sentence: sentence,
            detail: detail,
            startsAt: startsAt,
            endsAt: endsAt,
            icon: icon
        )
    }
}

public struct NextItem: Equatable, Sendable {
    public let label: String
    public let startsAt: Date
}

public struct ClearCard: Equatable, Sendable {
    public let allDone: Bool
    public let next: NextItem?
}

public enum PhoneCard: Equatable, Sendable {
    case task(TaskCard)
    case clear(ClearCard)
}

public struct TimelineSlice: Equatable, Sendable {
    public let at: Date
    public let cards: [PhoneCard]
}

public enum TimelineError: Error, Equatable {
    case unreadable
    case unknownCardKind(String)
    case invalid(String)
}

public struct DeviceTimeline: Equatable, Sendable {
    public let version: String
    public let generatedAt: Date
    public let timeZone: TimeZone
    public let until: Date
    public let slices: [TimelineSlice]

    public static func decode(_ data: Data) throws -> DeviceTimeline {
        let wire: WireTimeline
        do {
            wire = try JSONDecoder().decode(WireTimeline.self, from: data)
        } catch let error as TimelineError {
            throw error
        } catch {
            throw TimelineError.unreadable
        }
        return try wire.validated()
    }
}

func date(fromEpochMs value: Double) -> Date {
    Date(timeIntervalSince1970: value / 1000)
}

func epochMs(_ date: Date) -> Double {
    (date.timeIntervalSince1970 * 1000).rounded()
}

func presentText(_ value: String?) -> String? {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return value
}

private struct WireTimeline: Decodable {
    let version: String
    let generatedAt: Double
    let timezone: String
    let until: Double
    let entries: [WireSlice]

    func validated() throws -> DeviceTimeline {
        guard let zone = TimeZone(identifier: timezone) else {
            throw TimelineError.invalid("unknown time zone \(timezone)")
        }
        guard until > generatedAt else { throw TimelineError.invalid("until is not after generatedAt") }
        guard let first = entries.first else { throw TimelineError.invalid("no entries") }
        guard first.at == generatedAt else { throw TimelineError.invalid("first entry is not at generatedAt") }
        for (earlier, later) in zip(entries, entries.dropFirst()) where later.at <= earlier.at {
            throw TimelineError.invalid("entries are not ascending")
        }
        guard let last = entries.last, last.at < until else {
            throw TimelineError.invalid("an entry starts at or after until")
        }
        let slices = try entries.map { try $0.validated() }
        return DeviceTimeline(
            version: version,
            generatedAt: date(fromEpochMs: generatedAt),
            timeZone: zone,
            until: date(fromEpochMs: until),
            slices: slices
        )
    }
}

private struct WireSlice: Decodable {
    let at: Double
    let cards: [PhoneCard]

    func validated() throws -> TimelineSlice {
        guard case .clear = cards.last else {
            throw TimelineError.invalid("cards do not end with a clear card")
        }
        let clearCount = cards.filter { if case .clear = $0 { return true } else { return false } }.count
        guard clearCount == 1 else { throw TimelineError.invalid("cards hold more than one clear card") }
        return TimelineSlice(at: date(fromEpochMs: at), cards: cards)
    }
}

extension PhoneCard: Decodable {
    private enum CodingKeys: String, CodingKey {
        case kind, allDone, next
    }

    private struct WireNext: Decodable {
        let label: String
        let startsAt: Double
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "task":
            self = .task(try TaskCard(from: decoder))
        case "clear":
            let next = try container.decodeIfPresent(WireNext.self, forKey: .next)
            if let next, presentText(next.label) == nil {
                throw TimelineError.invalid("next item has no label")
            }
            self = .clear(
                ClearCard(
                    allDone: try container.decode(Bool.self, forKey: .allDone),
                    next: next.map { NextItem(label: $0.label, startsAt: date(fromEpochMs: $0.startsAt)) }
                )
            )
        default:
            throw TimelineError.unknownCardKind(kind)
        }
    }
}

extension TaskCard: Codable {
    private enum CodingKeys: String, CodingKey {
        case instanceId, step, stepCount, stepText, label, sentence, detail, startsAt, endsAt, icon
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let step = try container.decode(Int.self, forKey: .step)
        let stepCount = try container.decode(Int.self, forKey: .stepCount)
        guard step >= 0, stepCount >= 1, step < stepCount else {
            throw TimelineError.invalid("step \(step) is outside \(stepCount) steps")
        }
        let instanceId = try container.decode(String.self, forKey: .instanceId)
        guard presentText(instanceId) != nil else { throw TimelineError.invalid("task has no instanceId") }
        guard let label = presentText(try container.decode(String.self, forKey: .label)) else {
            throw TimelineError.invalid("task has no label")
        }
        self.init(
            instanceId: instanceId,
            step: step,
            stepCount: stepCount,
            stepText: presentText(try container.decodeIfPresent(String.self, forKey: .stepText)),
            label: label,
            sentence: presentText(try container.decodeIfPresent(String.self, forKey: .sentence)),
            detail: presentText(try container.decodeIfPresent(String.self, forKey: .detail)),
            startsAt: date(fromEpochMs: try container.decode(Double.self, forKey: .startsAt)),
            endsAt: date(fromEpochMs: try container.decode(Double.self, forKey: .endsAt)),
            icon: (try container.decodeIfPresent(String.self, forKey: .icon)).flatMap(TaskIcon.init(rawValue:))
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(instanceId, forKey: .instanceId)
        try container.encode(step, forKey: .step)
        try container.encode(stepCount, forKey: .stepCount)
        try container.encode(stepText, forKey: .stepText)
        try container.encode(label, forKey: .label)
        try container.encode(sentence, forKey: .sentence)
        try container.encode(detail, forKey: .detail)
        try container.encode(epochMs(startsAt), forKey: .startsAt)
        try container.encode(epochMs(endsAt), forKey: .endsAt)
        try container.encode(icon, forKey: .icon)
    }
}
