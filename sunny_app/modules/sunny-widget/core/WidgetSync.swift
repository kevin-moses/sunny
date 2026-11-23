import Foundation

public enum FlushResult: String, Equatable, Sendable {
    case clean
    case pending
    case unauthorized
    case noCredentials
}

public enum StoredPress: Equatable, Sendable {
    case noCredentials
    case stored(Press)
    case sentUnstored(FlushResult)
}

public enum StoredUndo: Equatable, Sendable {
    case noCredentials
    case stored
    case notStored
}

public enum ReporterLaunch: Equatable, Sendable {
    case observe
    case endActivities
}

public enum ReportOutcome: Equatable, Sendable {
    case sent(PushStateOutcome)
    case notPaired
    case credentialsUnreadable

    public var lostAccess: Bool {
        switch self {
        case .sent(.unauthorized), .notPaired: return true
        case .sent(.answered), .sent(.failed), .credentialsUnreadable: return false
        }
    }
}

private enum Credentials {
    case paired(DeviceClient)
    case notPaired
    case unreadable

    var client: DeviceClient? {
        guard case .paired(let client) = self else { return nil }
        return client
    }

    var unsentResult: FlushResult {
        guard case .notPaired = self else { return .pending }
        return .noCredentials
    }
}

public struct WidgetSync: Sendable {
    public static let fetchTimeout: TimeInterval = 10
    public static let pressTimeout: TimeInterval = 4
    public static let reportTimeout: TimeInterval = 10
    public static let clearTimeout: TimeInterval = 3

    let storage: WidgetStorage
    let tokens: TokenStore
    let sites: SiteStore
    let transport: HTTPTransport
    let clock: @Sendable () -> Date

    public init(
        storage: WidgetStorage,
        tokens: TokenStore,
        sites: SiteStore,
        transport: HTTPTransport,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.storage = storage
        self.tokens = tokens
        self.sites = sites
        self.transport = transport
        self.clock = clock
    }

    public func storedSiteURL() -> URL? {
        guard let site = sites.read() else { return nil }
        return tokens.read() == nil ? nil : site
    }

    public func reporterLaunch() -> ReporterLaunch {
        tokens.lookup() == .absent ? .endActivities : .observe
    }

    public func storeCredentials(token: String, siteURL: URL) throws {
        try storage.withCredentialsLock {
            try tokens.write(token)
            sites.write(siteURL)
        }
    }

    public func clear() async throws {
        _ = await replayPresses(timeout: Self.clearTimeout)
        try storage.withCredentialsLock {
            tokens.remove(ifEqualTo: nil)
            sites.remove()
        }
        try storage.removeAll()
    }

    public func pressDone(
        instanceId: String,
        step: Int,
        via: PressVia,
        showPress: (Date) async -> Void = { _ in }
    ) async -> FlushResult {
        switch await storePress(instanceId: instanceId, step: step, via: via, showPress: showPress) {
        case .noCredentials: return .noCredentials
        case .sentUnstored(let result): return result
        case .stored: return await replayPresses(timeout: Self.pressTimeout)
        }
    }

    public func storePress(
        instanceId: String,
        step: Int,
        via: PressVia,
        showPress: (Date) async -> Void = { _ in }
    ) async -> StoredPress {
        let credentials = credentials()
        if case .notPaired = credentials { return .noCredentials }
        let press = Press(instanceId: instanceId, step: step, via: via, pressedAt: clock())
        do {
            try storage.presses.append(press)
        } catch {
            return .sentUnstored(await sendUnqueued(press, with: credentials, showPress: showPress))
        }
        await showPress(press.pressedAt)
        return .stored(press)
    }

    public func storeUndo(ofPress pressId: UUID) -> StoredUndo {
        if case .notPaired = credentials() { return .noCredentials }
        guard let record = storage.presses.record(pressId) else { return .notStored }
        let undo = PressUndo(pressId: pressId, instanceId: record.press.instanceId, undoneAt: clock())
        return (try? storage.presses.append(undo)) == nil ? .notStored : .stored
    }

    public func pressLog() -> [PressRecord] {
        storage.presses.records()
    }

    private func sendUnqueued(
        _ press: Press,
        with credentials: Credentials,
        showPress: (Date) async -> Void
    ) async -> FlushResult {
        guard let client = credentials.client else { return credentials.unsentResult }
        let outcome = await client.send(.confirm(press), at: clock(), timeout: Self.pressTimeout)
        switch PressReplay.decision(for: outcome) {
        case .drop:
            if outcome.answer?.status.applied == true { await showPress(press.pressedAt) }
            return .clean
        case .keepAndHoldTask, .keepAndStop: return .pending
        case .keepAndStopUnauthorized:
            dropToken(client.token)
            return .unauthorized
        }
    }

    public func replayPresses(timeout: TimeInterval) async -> FlushResult {
        await replay(with: credentials(), timeout: timeout)
    }

    private func replay(with credentials: Credentials, timeout: TimeInterval) async -> FlushResult {
        guard let client = credentials.client else { return credentials.unsentResult }
        let deadline = clock().addingTimeInterval(timeout)
        var held: Set<String> = []
        for send in storage.presses.unsent() where !held.contains(send.instanceId) {
            let left = deadline.timeIntervalSince(clock())
            guard left > 0 else { return .pending }
            let outcome = await client.send(send, at: clock(), timeout: left)
            switch PressReplay.decision(for: outcome) {
            case .drop:
                let answer = PressAnswer(
                    at: clock(),
                    applied: outcome.answer?.status.applied ?? false,
                    answeredPresses: outcome.answer?.answeredPresses
                )
                storage.presses.answered(send, with: answer)
            case .keepAndHoldTask:
                held.insert(send.instanceId)
            case .keepAndStop:
                return .pending
            case .keepAndStopUnauthorized:
                dropToken(client.token)
                return .unauthorized
            }
        }
        return held.isEmpty ? .clean : .pending
    }

    public func reportPushState(_ report: PushStateReport) async -> ReportOutcome {
        switch credentials() {
        case .notPaired:
            return .notPaired
        case .unreadable:
            return .credentialsUnreadable
        case .paired(let client):
            let outcome = await client.reportPushState(report, timeout: Self.reportTimeout)
            if outcome == .unauthorized { dropToken(client.token) }
            return .sent(outcome)
        }
    }

    public func storedWidgetPush() -> WidgetPushReport? {
        storage.loadWidgetPush()
    }

    public func storeWidgetPush(token: String) -> PushStateReport {
        let widgetPush = WidgetPushReport(token: token)
        try? storage.saveWidgetPush(widgetPush)
        return PushStateReport(liveActivityStart: nil, activities: nil, widgetPush: widgetPush)
    }

    public func cachedPlan(locale: Locale) -> TimelinePlan {
        let now = clock()
        guard credentials().client != nil else { return TimelinePlanner.notice(.openSunny, at: now) }
        return TimelinePlanner.plan(
            at: now,
            timeline: storage.loadCache(),
            pressed: storage.hiddenCards(),
            locale: locale
        )
    }

    public func refresh(locale: Locale) async -> TimelinePlan {
        let credentials = credentials()
        guard let client = credentials.client else { return TimelinePlanner.notice(.openSunny, at: clock()) }
        if await replay(with: credentials, timeout: Self.pressTimeout) == .unauthorized {
            return TimelinePlanner.notice(.openSunny, at: clock())
        }
        let cache = storage.loadCache()
        let fetchStartedAt = clock()
        let cachedVersion = cache.flatMap { ReloadPolicy.needsRenewal($0, at: fetchStartedAt) ? nil : $0.version }
        let outcome = await client.fetchTimeline(cachedVersion: cachedVersion, timeout: Self.fetchTimeout)
        let now = clock()
        let plan = { (timeline: DeviceTimeline?, notBefore: Date?) in
            TimelinePlanner.plan(
                at: now,
                timeline: timeline,
                pressed: storage.hiddenCards(),
                locale: locale,
                notBefore: notBefore
            )
        }
        switch outcome {
        case .fresh(let body):
            guard let timeline = try? DeviceTimeline.decode(body) else { return plan(cache, nil) }
            if (try? storage.saveCache(body: body)) != nil { storage.timelineFetched(from: fetchStartedAt) }
            return plan(timeline, nil)
        case .notModified:
            guard let cache else { return TimelinePlanner.plan(at: now, timeline: nil, pressed: [], locale: locale) }
            storage.timelineFetched(from: fetchStartedAt)
            return plan(cache, nil)
        case .unauthorized:
            dropToken(client.token)
            return TimelinePlanner.notice(.openSunny, at: now)
        case .rateLimited(let retryAfter):
            return plan(cache, retryAfter.map { now.addingTimeInterval($0) })
        case .failed:
            return plan(cache, nil)
        }
    }

    private func credentials() -> Credentials {
        switch tokens.lookup() {
        case .absent:
            return .notPaired
        case .unreadable:
            return .unreadable
        case .present(let token):
            guard let siteURL = sites.read() else { return .unreadable }
            return .paired(DeviceClient(siteURL: siteURL, token: token, transport: transport))
        }
    }

    private func dropToken(_ token: String) {
        try? storage.withCredentialsLock { tokens.remove(ifEqualTo: token) }
    }
}
