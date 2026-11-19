import ActivityKit
import Foundation
import SunnyWidgetCore
import WidgetKit

public actor PushStateReporter {
    public static let shared = PushStateReporter()

    private let lane = SyncLane { await PushStateReporter.sendSnapshot() }
    private var watched: Set<String> = []

    public nonisolated func start() {
        Task { await self.observe() }
    }

    public func sync() async {
        await lane.requestSync()
    }

    public func confirm(instanceId: String, step: Int) async {
        let pressedAt = Date()
        let store = ActivityKitStore()
        let flushed = await WidgetSync.live()?.pressDone(instanceId: instanceId, step: step, via: .liveActivity)
        await TaskActivities.showPress(instanceId: instanceId, step: step, at: pressedAt, in: store)
        await endAllIfUnauthorized(flushed, in: store)
        await sync()
    }

    public func refreshFromPush() async {
        let flushed = await WidgetSync.live()?.replayPresses(timeout: WidgetSync.pressTimeout)
        await endAllIfUnauthorized(flushed, in: ActivityKitStore())
        await sync()
    }

    public func clear(_ widgetSync: WidgetSync) async -> Result<Bool, Error> {
        await lane.run {
            await TaskActivities.endAll(in: ActivityKitStore())
            _ = await widgetSync.reportPushState(.cleared)
            let result = Result { try widgetSync.clear() }
            WidgetCenter.shared.reloadAllTimelines()
            return result
        }
    }

    private func endAllIfUnauthorized(_ flushed: FlushResult?, in store: ActivityKitStore) async {
        if flushed == .unauthorized { await TaskActivities.endAll(in: store) }
    }

    private func observe() {
        Task {
            for await _ in Activity<SunnyTaskAttributes>.pushToStartTokenUpdates { await self.sync() }
        }
        Task {
            for await _ in ActivityAuthorizationInfo().activityEnablementUpdates { await self.sync() }
        }
        Task {
            for await activity in Activity<SunnyTaskAttributes>.activityUpdates { self.watch(activity) }
        }
        Activity<SunnyTaskAttributes>.activities.forEach(watch)
        Task { await self.sync() }
    }

    private func watch(_ activity: Activity<SunnyTaskAttributes>) {
        guard watched.insert(activity.id).inserted else { return }
        Task {
            for await _ in activity.pushTokenUpdates { await self.sync() }
        }
        Task {
            for await _ in activity.activityStateUpdates { await self.sync() }
        }
        Task { await self.sync() }
    }

    private static func sendSnapshot() async {
        defer { WidgetCenter.shared.reloadAllTimelines() }
        guard let widgetSync = WidgetSync.live() else { return }
        let store = ActivityKitStore()
        await TaskActivities.endDuplicates(in: store)
        let report = TaskActivities.report(
            startToken: Activity<SunnyTaskAttributes>.pushToStartToken?.hexString,
            enabled: ActivityAuthorizationInfo().areActivitiesEnabled,
            store: store,
            widgetPush: widgetSync.storedWidgetPush()
        )
        await TaskActivities.settle(await widgetSync.reportPushState(report), in: store)
    }
}
