import Foundation

public actor SyncLane {
    private let sync: @Sendable () async -> Void
    private var tail: Task<Void, Never>?
    private var waitingSync: Task<Void, Never>?

    public init(sync: @escaping @Sendable () async -> Void) {
        self.sync = sync
    }

    public func requestSync() async {
        if let waitingSync {
            await waitingSync.value
            return
        }
        let previous = tail
        let task = Task {
            await previous?.value
            self.syncStarted()
            await sync()
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

    private func syncStarted() {
        waitingSync = nil
    }
}
