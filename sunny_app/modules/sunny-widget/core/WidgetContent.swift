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

    public static func noted(at time: String) -> String {
        "Noted at \(time)"
    }
}

public struct DueContent: Equatable, Sendable {
    public let instanceId: String
    public let step: Int
    public let time: String
    public let label: String
    public let line: String?
    public let stepLine: String?
    public let detail: String?
    public let icon: TaskIcon?

    public init(
        instanceId: String,
        step: Int,
        time: String,
        label: String,
        line: String?,
        stepLine: String?,
        detail: String?,
        icon: TaskIcon?
    ) {
        self.instanceId = instanceId
        self.step = step
        self.time = time
        self.label = label
        self.line = line
        self.stepLine = stepLine
        self.detail = detail
        self.icon = icon
    }

    public static func from(_ task: TaskCard, timeZone: TimeZone, locale: Locale) -> DueContent {
        DueContent(
            instanceId: task.instanceId,
            step: task.step,
            time: ClockFormat.time(task.startsAt, in: timeZone, locale: locale),
            label: task.label,
            line: task.stepCount > 1 ? task.stepText : task.sentence,
            stepLine: task.stepCount > 1 ? task.stepText : nil,
            detail: task.detail,
            icon: task.icon
        )
    }

    public var secondLine: String? {
        stepLine ?? detail
    }

    public var symbolName: String {
        TaskIcon.symbolName(icon)
    }

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

    public init(label: String, time: String) {
        self.label = label
        self.time = time
    }

    public var leadText: String {
        "\(WidgetWords.next): \(label)"
    }

    public var atTimeText: String {
        "at \(time)"
    }

    public var panelText: String {
        "\(leadText) \(atTimeText)"
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

    public init(headline: String, next: NextContent?) {
        self.headline = headline
        self.next = next
    }
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

    public static func from(_ pick: PhoneCard, timeZone: TimeZone, locale: Locale) -> WidgetContent {
        let clock = { (date: Date) in ClockFormat.time(date, in: timeZone, locale: locale) }
        switch pick {
        case .task(let task):
            return .due(DueContent.from(task, timeZone: timeZone, locale: locale))
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
