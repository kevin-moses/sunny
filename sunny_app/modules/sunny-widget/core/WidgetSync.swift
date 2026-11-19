import Foundation

public enum FlushResult: String, Equatable, Sendable {
    case clean
    case pending
    case unauthorized
    case noCredentials
}

public enum ReportOutcome: Equatable, Sendable {
    case sent(PushStateOutcome)
    case notPaired
    case credentialsUnreadable
}

private enum Credentials {
    case paired(DeviceClient)
    case notPaired
    case unreadable
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
        tokens.read() == nil ? nil : sites.read()
    }

    public func storeCredentials(token: String, siteURL: URL) throws {
        try storage.withCredentialsLock {
            try tokens.write(token)
            sites.write(siteURL)
        }
    }

    @discardableResult
    public func clear() async throws -> Bool {
        _ = await replayPresses(timeout: Self.clearTimeout)
        let removedCredentials = try storage.withCredentialsLock {
            let removedToken = tokens.remove(ifEqualTo: nil)
            let removedSite = sites.remove()
            return removedToken || removedSite
        }
        let removedFiles = try storage.removeAll()
        return removedCredentials || removedFiles
    }

    public func pressDone(
        instanceId: String,
        step: Int,
        via: PressVia,
        whenKept: (Date) async -> Void = { _ in }
    ) async -> FlushResult {
        let press = Press(instanceId: instanceId, step: step, via: via, pressedAt: clock())
        do {
            try storage.presses.append(press)
        } catch {
            return await sendUnqueued(press, whenKept: whenKept)
        }
        await whenKept(press.pressedAt)
        return await replayPresses(timeout: Self.pressTimeout)
    }

    private func sendUnqueued(_ press: Press, whenKept: (Date) async -> Void) async -> FlushResult {
        guard let client = client() else { return .noCredentials }
        let outcome = await client.confirm(press, at: clock(), timeout: Self.pressTimeout)
        switch PressReplay.decision(for: outcome) {
        case .drop:
            await whenKept(press.pressedAt)
            return .clean
        case .keepAndHoldTask, .keepAndStop: return .pending
        case .keepAndStopUnauthorized:
            dropToken(client.token)
            return .unauthorized
        }
    }

    public func replayPresses(timeout: TimeInterval) async -> FlushResult {
        guard let client = client() else { return .noCredentials }
        let deadline = clock().addingTimeInterval(timeout)
        var held: Set<String> = []
        for press in storage.presses.pending() where !held.contains(press.instanceId) {
            let left = deadline.timeIntervalSince(clock())
            guard left > 0 else { return .pending }
            let outcome = await client.confirm(press, at: clock(), timeout: left)
            switch PressReplay.decision(for: outcome) {
            case .drop:
                storage.presses.answered(press.id, at: clock())
            case .keepAndHoldTask:
                held.insert(press.instanceId)
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

    public func householdTimeZone() -> TimeZone {
        storage.loadCache()?.timeline.timeZone ?? .autoupdatingCurrent
    }

    public func cachedPlan(locale: Locale) -> TimelinePlan {
        let now = clock()
        guard client() != nil else { return TimelinePlanner.notice(.openSunny, at: now) }
        return TimelinePlanner.plan(
            at: now,
            timeline: storage.loadCache()?.timeline,
            pressed: storage.presses.pressed(),
            locale: locale
        )
    }

    public func refresh(locale: Locale) async -> TimelinePlan {
        guard let client = client() else { return TimelinePlanner.notice(.openSunny, at: clock()) }
        if await replayPresses(timeout: Self.pressTimeout) == .unauthorized {
            return TimelinePlanner.notice(.openSunny, at: clock())
        }
        let cache = storage.loadCache()
        let fetchStartedAt = clock()
        let etag = cache.flatMap { ReloadPolicy.needsRenewal($0.timeline, at: fetchStartedAt) ? nil : $0.etag }
        let outcome = await client.fetchTimeline(etag: etag, timeout: Self.fetchTimeout)
        let now = clock()
        let plan = { (timeline: DeviceTimeline?, pressed: Set<PressKey>, notBefore: Date?) in
            TimelinePlanner.plan(at: now, timeline: timeline, pressed: pressed, locale: locale, notBefore: notBefore)
        }
        switch outcome {
        case .fresh(let body, let newEtag):
            guard let timeline = try? DeviceTimeline.decode(body) else {
                return plan(cache?.timeline, storage.presses.pressed(), nil)
            }
            let saved = (try? storage.saveCache(body: body, etag: newEtag)) != nil
            return plan(timeline, saved ? reconciledPressed(since: fetchStartedAt) : storage.presses.pressed(), nil)
        case .notModified:
            guard let cache else { return plan(nil, [], nil) }
            return plan(cache.timeline, reconciledPressed(since: fetchStartedAt), nil)
        case .unauthorized:
            dropToken(client.token)
            return TimelinePlanner.notice(.openSunny, at: now)
        case .rateLimited(let retryAfter):
            return plan(cache?.timeline, storage.presses.pressed(), retryAfter.map { now.addingTimeInterval($0) })
        case .failed:
            return plan(cache?.timeline, storage.presses.pressed(), nil)
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

    private func client() -> DeviceClient? {
        guard case .paired(let client) = credentials() else { return nil }
        return client
    }

    private func reconciledPressed(since fetchStartedAt: Date) -> Set<PressKey> {
        storage.presses.reconcile(withTimelineFetchedFrom: fetchStartedAt)
        return storage.presses.pressed()
    }

    private func dropToken(_ token: String) {
        _ = try? storage.withCredentialsLock { tokens.remove(ifEqualTo: token) }
    }
}
