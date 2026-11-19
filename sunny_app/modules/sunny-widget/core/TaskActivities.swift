import Foundation

public struct ShownActivity: Equatable, Sendable {
    public let attributes: SunnyTaskAttributes
    public let state: TaskActivityState
    public let staleAt: Date?
    public let token: String?
    public let phase: ReportedActivityState

    public init(
        attributes: SunnyTaskAttributes,
        state: TaskActivityState,
        staleAt: Date?,
        token: String?,
        phase: ReportedActivityState
    ) {
        self.attributes = attributes
        self.state = state
        self.staleAt = staleAt
        self.token = token
        self.phase = phase
    }

    public var report: ActivityReport {
        ActivityReport(key: attributes.activityKey, token: token, state: phase)
    }
}

public enum ActivityDismissal: Equatable, Sendable {
    case immediate
    case after(Date)
}

public protocol TaskActivityStore: Sendable {
    func shown() -> [ShownActivity]
    func update(key: String, to state: TaskActivityState, staleAt: Date?) async
    func end(key: String, with state: TaskActivityState, dismissal: ActivityDismissal) async
}

public enum TaskActivities {
    public static func showPress(instanceId: String, step: Int, at now: Date, in store: TaskActivityStore) async {
        for activity in store.shown() where activity.attributes.instanceId == instanceId {
            switch PressEffect.after(activity.state, pressedStep: step, at: now) {
            case .advance(let next):
                await store.update(key: activity.attributes.activityKey, to: next, staleAt: activity.staleAt)
            case .finish(let receipt):
                await store.end(
                    key: activity.attributes.activityKey,
                    with: receipt,
                    dismissal: .after(now.addingTimeInterval(activity.attributes.receiptDuration))
                )
            case nil:
                continue
            }
        }
    }

    public static func apply(_ directives: [ActivityDirective], to store: TaskActivityStore) async {
        let keys = Set(store.shown().map(\.attributes.activityKey))
        for directive in directives where keys.contains(directive.key) {
            switch directive {
            case .update(let key, let state, let staleAt):
                await store.update(key: key, to: state, staleAt: staleAt)
            case .end(let key, let state):
                await store.end(key: key, with: state, dismissal: .immediate)
            }
        }
    }

    public static func endAll(in store: TaskActivityStore) async {
        for activity in store.shown() {
            await store.end(key: activity.attributes.activityKey, with: activity.state, dismissal: .immediate)
        }
    }

    public static func report(
        startToken: String?,
        enabled: Bool,
        store: TaskActivityStore,
        widgetPush: WidgetPushReport?
    ) -> PushStateReport {
        PushStateReport(
            liveActivityStart: StartTokenReport(token: startToken, enabled: enabled),
            activities: store.shown().map(\.report),
            widgetPush: widgetPush
        )
    }
}
