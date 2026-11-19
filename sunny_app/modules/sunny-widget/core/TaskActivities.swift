import Foundation

public struct ShownActivity: Equatable, Sendable {
    public let id: String
    public let attributes: SunnyTaskAttributes
    public let state: TaskActivityState
    public let staleAt: Date?
    public let token: String?
    public let phase: ReportedActivityState

    public init(
        id: String,
        attributes: SunnyTaskAttributes,
        state: TaskActivityState,
        staleAt: Date?,
        token: String?,
        phase: ReportedActivityState
    ) {
        self.id = id
        self.attributes = attributes
        self.state = state
        self.staleAt = staleAt
        self.token = token
        self.phase = phase
    }

    public var key: String { attributes.activityKey }

    public var isOnScreen: Bool { phase == .active || phase == .stale }

    public var report: ActivityReport {
        ActivityReport(key: key, token: token, state: phase)
    }
}

public enum ActivityDismissal: Equatable, Sendable {
    case immediate
    case after(Date)
}

public protocol TaskActivityStore: Sendable {
    func shown() -> [ShownActivity]
    func update(id: String, to state: TaskActivityState, staleAt: Date?) async
    func end(id: String, with state: TaskActivityState, dismissal: ActivityDismissal) async
}

public enum TaskActivities {
    public static func showPress(
        instanceId: String,
        step: Int,
        at now: Date,
        withReceipt: Bool,
        in store: TaskActivityStore
    ) async {
        for activity in onScreen(store) where activity.attributes.instanceId == instanceId {
            switch PressEffect.after(activity.state, pressedStep: step, at: now) {
            case .advance(let next):
                await store.update(id: activity.id, to: next, staleAt: activity.staleAt)
            case .finish(let receipt):
                let dismissal: ActivityDismissal =
                    withReceipt ? .after(now.addingTimeInterval(activity.attributes.receiptDuration)) : .immediate
                await store.end(id: activity.id, with: receipt, dismissal: dismissal)
            case nil:
                continue
            }
        }
    }

    public static func apply(_ directives: [ActivityDirective], to store: TaskActivityStore) async {
        let shown = onScreen(store)
        for directive in directives {
            for activity in shown where activity.key == directive.key {
                switch directive {
                case .update(_, let state, let staleAt):
                    guard state != activity.state || staleAt != activity.staleAt else { continue }
                    await store.update(id: activity.id, to: state, staleAt: staleAt)
                case .end(_, let state):
                    await store.end(id: activity.id, with: state ?? activity.state, dismissal: .immediate)
                }
            }
        }
    }

    public static func settle(_ outcome: ReportOutcome, in store: TaskActivityStore) async {
        switch outcome {
        case .sent(.answered(let reply)):
            await apply(reply.directives, to: store)
        case .sent(.unauthorized), .notPaired:
            await endAll(in: store)
        case .sent(.failed), .credentialsUnreadable:
            return
        }
    }

    public static func endDuplicates(in store: TaskActivityStore) async {
        var kept: Set<String> = []
        for activity in onScreen(store) where !kept.insert(activity.key).inserted {
            await store.end(id: activity.id, with: activity.state, dismissal: .immediate)
        }
    }

    public static func endAll(in store: TaskActivityStore) async {
        for activity in onScreen(store) {
            await store.end(id: activity.id, with: activity.state, dismissal: .immediate)
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
            activities: Array(onePerKey(store.shown()).prefix(PushStateReport.maxActivities)).map(\.report),
            widgetPush: widgetPush
        )
    }

    private static func onePerKey(_ activities: [ShownActivity]) -> [ShownActivity] {
        var listed: Set<String> = []
        let onScreenFirst = activities.filter(\.isOnScreen) + activities.filter { !$0.isOnScreen }
        return onScreenFirst.filter { listed.insert($0.key).inserted }
    }

    private static func onScreen(_ store: TaskActivityStore) -> [ShownActivity] {
        store.shown().filter(\.isOnScreen)
    }
}

extension WidgetSync {
    public func pressDoneOnActivity(instanceId: String, step: Int, in store: TaskActivityStore) async -> FlushResult {
        let result = await pressDone(instanceId: instanceId, step: step, via: .liveActivity) { pressedAt in
            await TaskActivities.showPress(instanceId: instanceId, step: step, at: pressedAt, withReceipt: true, in: store)
        }
        if result == .unauthorized || result == .noCredentials { await TaskActivities.endAll(in: store) }
        return result
    }

    public func markAppPress(id: UUID, instanceId: String, step: Int, pressedAt: Date, in store: TaskActivityStore) async throws {
        try storage.presses.mark(id, key: PressKey(instanceId: instanceId, step: step), at: pressedAt)
        await TaskActivities.showPress(instanceId: instanceId, step: step, at: pressedAt, withReceipt: false, in: store)
    }

    public func answerAppPress(id: UUID) {
        storage.presses.answered(id, at: clock())
    }

    public func withdrawAppPress(id: UUID) {
        storage.presses.removeMark(id)
    }

    public func unsentPresses() -> [Press] {
        storage.presses.pending()
    }
}
