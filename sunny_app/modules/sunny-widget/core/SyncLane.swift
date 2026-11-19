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
        let task = append(sync, isSync: true)
        waitingSync = task
        await task.value
    }

    public func run(_ work: @escaping @Sendable () async -> Void) async {
        await append(work, isSync: false).value
    }

    private func append(_ work: @escaping @Sendable () async -> Void, isSync: Bool) -> Task<Void, Never> {
        let previous = tail
        let task = Task {
            await previous?.value
            self.started(isSync: isSync)
            await work()
        }
        tail = task
        return task
    }

    private func started(isSync: Bool) {
        if isSync { waitingSync = nil }
    }
}
