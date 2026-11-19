import ActivityKit
import Foundation
import SunnyWidgetCore

public struct ActivityKitStore: TaskActivityStore {
    public init() {}

    public func shown() -> [ShownActivity] {
        Activity<SunnyTaskAttributes>.activities.map { activity in
            ShownActivity(
                id: activity.id,
                attributes: activity.attributes,
                state: activity.content.state,
                staleAt: activity.content.staleDate,
                token: activity.pushToken?.hexString,
                phase: Self.phase(activity.activityState)
            )
        }
    }

    public func update(id: String, to state: TaskActivityState, staleAt: Date?) async {
        guard let activity = activity(id) else { return }
        let content = ActivityContent(state: state, staleDate: staleAt, relevanceScore: activity.content.relevanceScore)
        await activity.update(content)
    }

    public func end(id: String, with state: TaskActivityState, dismissal: ActivityDismissal) async {
        guard let activity = activity(id) else { return }
        await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: Self.policy(dismissal))
    }

    private func activity(_ id: String) -> Activity<SunnyTaskAttributes>? {
        Activity<SunnyTaskAttributes>.activities.first { $0.id == id }
    }

    static func phase(_ state: ActivityState) -> ReportedActivityState {
        switch state {
        case .stale: return .stale
        case .ended: return .ended
        case .dismissed: return .dismissed
        default: return .active
        }
    }

    static func policy(_ dismissal: ActivityDismissal) -> ActivityUIDismissalPolicy {
        switch dismissal {
        case .immediate: return .immediate
        case .after(let date): return .after(date)
        }
    }
}
