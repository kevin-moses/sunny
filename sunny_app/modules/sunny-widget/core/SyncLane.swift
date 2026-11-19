import Foundation

public enum SyncTrigger: Sendable, CaseIterable {
    case launch
    case startToken
    case enablement
    case activityChange
    case refreshPush
    case appSurfaces
    case press

    public var reloadsWidget: Bool {
        switch self {
        case .launch, .startToken, .enablement, .activityChange: return false
        case .refreshPush, .appSurfaces, .press: return true
        }
    }
}

public actor SyncLane {
    private let sync: @Sendable (_ reloadingWidget: Bool) async -> Void
    private var tail: Task<Void, Never>?
    private var waitingSync: Task<Void, Never>?
    private var waitingReload = false

    public init(sync: @escaping @Sendable (_ reloadingWidget: Bool) async -> Void) {
        self.sync = sync
    }

    public func requestSync(_ trigger: SyncTrigger) async {
        waitingReload = waitingReload || trigger.reloadsWidget
        if let waitingSync {
            await waitingSync.value
            return
        }
        let previous = tail
        let task = Task {
            await previous?.value
            let reloadingWidget = self.syncStarted()
            await sync(reloadingWidget)
        }
        tail = task
        waitingSync = task
        await task.value
    }

    public func run<Value: Sendable>(_ work: @escaping @Sendable () async -> Value) async -> Value {
        let previous = tail
        let task = Task {
            await previous?.value
            return await work()
        }
        tail = Task { _ = await task.value }
        return await task.value
    }

    private func syncStarted() -> Bool {
        waitingSync = nil
        defer { waitingReload = false }
        return waitingReload
    }
}
