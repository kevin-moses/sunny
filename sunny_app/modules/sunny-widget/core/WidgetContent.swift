import Foundation

public enum WidgetWords {
    public static let now = "Now"
    public static let done = "Done"
    public static let nothingToDo = "Nothing to do right now."
    public static let everythingDone = "Everything is done."
    public static let notConnected = "Not connected. Open Sunny to update."
    public static let openSunny = "Open Sunny to see your day."
    public static let appName = "Sunny"
    public static let next = "Next"
}

public struct DueContent: Equatable, Sendable {
    public let instanceId: String
    public let step: Int
    public let time: String
    public let label: String
    public let line: String?
    public let detail: String?

    public var spokenSummary: String {
        "\(WidgetWords.now), \(time), \(line ?? label)"
    }

    public var doneAccessibilityLabel: String {
        "\(WidgetWords.done), \(label)"
    }

    public var inlineText: String {
        "\(label) now"
    }
}

public struct NextContent: Equatable, Sendable {
    public let label: String
    public let time: String

    public var panelText: String {
        "\(WidgetWords.next): \(label) at \(time)"
    }

    public var shortText: String {
        "\(WidgetWords.next): \(label) \(time)"
    }

    public var shortestText: String {
        "\(WidgetWords.next): \(time)"
    }
}

public struct ClearContent: Equatable, Sendable {
    public let headline: String
    public let next: NextContent?
}

public enum Notice: Equatable, Sendable {
    case openSunny
    case notConnected

    public var text: String {
        switch self {
        case .openSunny: return WidgetWords.openSunny
        case .notConnected: return WidgetWords.notConnected
        }
    }
}

public enum WidgetContent: Equatable, Sendable {
    case due(DueContent)
    case clear(ClearContent)
    case notice(Notice)

    public static func from(_ pick: CardPick, timeZone: TimeZone, locale: Locale) -> WidgetContent {
        let clock = { (date: Date) in ClockFormat.time(date, in: timeZone, locale: locale) }
        switch pick {
        case .task(let task):
            return .due(
                DueContent(
                    instanceId: task.instanceId,
                    step: task.step,
                    time: clock(task.startsAt),
                    label: task.label,
                    line: task.stepCount > 1 ? task.stepText : task.sentence,
                    detail: task.detail
                )
            )
        case .clear(let clear):
            return .clear(
                ClearContent(
                    headline: clear.allDone ? WidgetWords.everythingDone : WidgetWords.nothingToDo,
                    next: clear.next.map { NextContent(label: $0.label, time: clock($0.startsAt)) }
                )
            )
        }
    }
}
