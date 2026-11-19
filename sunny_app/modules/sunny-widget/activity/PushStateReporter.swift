import ActivityKit
import Foundation
import SunnyWidgetCore
import WidgetKit

public actor PushStateReporter {
    public static let shared = PushStateReporter()

    private let lane = SyncLane { reloadingWidget in await PushStateReporter.sendSnapshot(reloadingWidget: reloadingWidget) }
    private var watched: [String: Task<Void, Never>] = [:]
    private var observing = false

    public nonisolated func start() {
        Task { await self.launch() }
    }

    public func startObserving() {
        observe()
    }

    public func sync(_ trigger: SyncTrigger) async {
        await lane.requestSync(trigger)
    }

    public func confirm(instanceId: String, step: Int) async {
        guard let widgetSync = WidgetSync.live() else { return }
        _ = await widgetSync.pressDoneOnActivity(instanceId: instanceId, step: step, in: ActivityKitStore())
        await sync(.press)
    }

    public func markAppPress(_ widgetSync: WidgetSync, id: UUID, instanceId: String, step: Int, pressedAt: Date) async throws {
        try await widgetSync.markAppPress(id: id, instanceId: instanceId, step: step, pressedAt: pressedAt, in: ActivityKitStore())
        await sync(.press)
    }

    public func refreshFromPush() async {
        if await WidgetSync.live()?.replayPresses(timeout: WidgetSync.pressTimeout) == .unauthorized {
            await TaskActivities.endAll(in: ActivityKitStore())
        }
        await sync(.refreshPush)
    }

    public func clear(_ widgetSync: WidgetSync) async throws {
        try await lane.run {
            await TaskActivities.endAll(in: ActivityKitStore())
            _ = await widgetSync.reportPushState(.cleared)
            let result: Result<Void, Error>
            do {
                try await widgetSync.clear()
                result = .success(())
            } catch {
                result = .failure(error)
            }
            WidgetCenter.shared.reloadAllTimelines()
            return result
        }.get()
    }

    private func launch() async {
        guard let widgetSync = WidgetSync.live() else { return }
        switch widgetSync.reporterLaunch() {
        case .observe:
            observe()
        case .endActivities:
            await TaskActivities.endAll(in: ActivityKitStore())
        }
    }

    private func observe() {
        guard !observing else { return }
        observing = true
        Task {
            for await _ in Activity<SunnyTaskAttributes>.pushToStartTokenUpdates { await self.sync(.startToken) }
        }
        Task {
            for await _ in ActivityAuthorizationInfo().activityEnablementUpdates { await self.sync(.enablement) }
        }
        Task {
            for await activity in Activity<SunnyTaskAttributes>.activityUpdates { self.watch(activity) }
        }
        Activity<SunnyTaskAttributes>.activities.forEach(watch)
        Task { await self.sync(.launch) }
    }

    private func watch(_ activity: Activity<SunnyTaskAttributes>) {
        guard watched[activity.id] == nil else { return }
        watched[activity.id] = Task {
            for await _ in activity.pushTokenUpdates { await self.sync(.activityChange) }
        }
        Task {
            for await state in activity.activityStateUpdates {
                await self.sync(.activityChange)
                if !ActivityKitStore.phase(state).isOnScreen { break }
            }
            self.unwatch(activity.id)
        }
        Task { await self.sync(.activityChange) }
    }

    private func unwatch(_ id: String) {
        watched.removeValue(forKey: id)?.cancel()
    }

    private static func sendSnapshot(reloadingWidget: Bool) async {
        defer {
            if reloadingWidget { WidgetCenter.shared.reloadAllTimelines() }
        }
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
