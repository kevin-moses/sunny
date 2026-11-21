import Foundation

public enum TaskActivityFace: Equatable, Sendable {
    case due(DueContent)
    case receipt(DueContent, noted: String)
    case over(DueContent)

    public init(state: TaskActivityState, isStale: Bool, timeZone: TimeZone, locale: Locale) {
        let due = DueContent.from(state.card, timeZone: timeZone, locale: locale)
        guard let closed = state.closed else {
            self = isStale ? .over(due) : .due(due)
            return
        }
        switch closed.kind {
        case .done:
            self = .receipt(due, noted: WidgetWords.noted(at: ClockFormat.time(closed.at, in: timeZone, locale: locale)))
        case .over:
            self = .over(due)
        }
    }

    public var content: DueContent {
        switch self {
        case .due(let due), .receipt(let due, _), .over(let due):
            return due
        }
    }
}

public enum PressEffect: Equatable, Sendable {
    case advance(TaskActivityState)
    case finish(TaskActivityState)

    public static func after(_ state: TaskActivityState, pressedStep: Int, at now: Date) -> PressEffect? {
        guard state.closed == nil, state.card.step == pressedStep else { return nil }
        if state.card.isLastStep {
            return .finish(
                TaskActivityState(card: state.card, nextSteps: [], closed: ActivityClosed(kind: .done, at: now))
            )
        }
        return .advance(
            TaskActivityState(
                card: state.card.advanced(stepText: state.nextSteps.first),
                nextSteps: Array(state.nextSteps.dropFirst()),
                closed: nil
            )
        )
    }
}
