import Foundation
import XCTest

@testable import SunnyWidgetCore

final class WidgetSyncTests: XCTestCase {
    private var directory: URL!
    private var transport: FakeTransport!
    private var tokens: MemoryTokenStore!
    private var sites: MemorySiteStore!
    private var clock: TestClock!

    override func setUpWithError() throws {
        directory = try temporaryDirectory()
        transport = FakeTransport()
        tokens = MemoryTokenStore("token-1")
        sites = MemorySiteStore(URL(string: "https://example.convex.site"))
        clock = TestClock(Fixture.generatedAt.addingTimeInterval(minutes(1)))
    }

    private func makeSync() -> WidgetSync {
        let clock = self.clock!
        return WidgetSync(
            storage: WidgetStorage(directory: directory),
            tokens: tokens,
            sites: sites,
            transport: transport,
            clock: { clock.now }
        )
    }

    private var queue: PressQueue { PressQueue(directory: directory) }

    private func firstContent(_ plan: TimelinePlan) -> WidgetContent? {
        plan.entries.first?.content
    }

    func testWithoutCredentialsAsksToOpenSunny() async {
        tokens = MemoryTokenStore(nil)
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        XCTAssertEqual(firstContent(plan), .notice(.openSunny))
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testFreshTimelineIsShownAndCached() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"), headers: ["ETag": "\"v1\""])
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        guard case .due(let due) = firstContent(plan) else { return XCTFail("expected the due task") }
        XCTAssertEqual(due.instanceId, "inst-morning-pills")
        XCTAssertEqual(WidgetStorage(directory: directory).loadCache()?.etag, "\"v1\"")
        XCTAssertEqual(transport.timelineRequests.first?.headers["Authorization"], "Bearer token-1")
        XCTAssertNil(transport.timelineRequests.first?.headers["If-None-Match"])
    }

    func testSendsTheEtagAndUsesTheCacheOnNotModified() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"), headers: ["ETag": "\"v1\""])
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        transport.queueTimeline(304)
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        XCTAssertEqual(transport.timelineRequests.last?.headers["If-None-Match"], "\"v1\"")
        guard case .due = firstContent(plan) else { return XCTFail("expected the cached due task") }
    }

    func testDropsTheEtagNearUntilSoTheTimelineRenews() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"), headers: ["ETag": "\"v1\""])
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        clock.advance(minutes(23 * 60))
        transport.queueTimeline(200, body: try Fixture.data("due-task"), headers: ["ETag": "\"v1\""])
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        XCTAssertNil(transport.timelineRequests.last?.headers["If-None-Match"])
    }

    func testOfflineUsesTheCache() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        transport.queueTimelineFailure()
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        guard case .due = firstContent(plan) else { return XCTFail("expected the cached due task") }
    }

    func testMalformedPayloadKeepsTheLastGoodCache() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"), headers: ["ETag": "\"v1\""])
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        transport.queueTimeline(200, body: Data("{\"version\":\"x\"}".utf8), headers: ["ETag": "\"bad\""])
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        guard case .due = firstContent(plan) else { return XCTFail("expected the cached due task") }
        XCTAssertEqual(WidgetStorage(directory: directory).loadCache()?.etag, "\"v1\"")
    }

    func testPastUntilWithoutAFreshPayloadShowsNotConnected() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        clock.advance(minutes(25 * 60))
        transport.queueTimelineFailure()
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        XCTAssertEqual(plan.entries.map(\.content), [.notice(.notConnected)])
    }

    func testUnauthorizedDropsTheTokenAndAsksToOpenSunny() async throws {
        transport.queueTimeline(401)
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        XCTAssertEqual(firstContent(plan), .notice(.openSunny))
        XCTAssertNil(tokens.read())
    }

    func testUnauthorizedDoesNotDropANewerToken() async throws {
        transport.queueConfirm(401)
        try queue.append(Press(instanceId: "inst", step: 0, via: .widget, pressedAt: clock.now))
        let rotating = RotatingTokenStore(first: "token-1", afterRead: "token-2")
        let sync = WidgetSync(
            storage: WidgetStorage(directory: directory),
            tokens: rotating,
            sites: sites,
            transport: transport
        )
        let result = await sync.replayPresses(timeout: 1)
        XCTAssertEqual(result, .unauthorized)
        XCTAssertEqual(rotating.current, "token-2")
        XCTAssertEqual(queue.pending().map(\.instanceId), ["inst"])
    }

    func testPressIsQueuedThenSentAndMovesTheWidgetOn() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        transport.queueConfirm(200, body: try Fixture.json(["status": "confirmed", "reason": NSNull(), "state": NSNull()]))
        let result = await makeSync().pressDone(instanceId: "inst-morning-pills", step: 0, via: .widget)
        XCTAssertEqual(result, .clean)
        XCTAssertEqual(queue.pending(), [])
        XCTAssertEqual(transport.confirmBodies.first?["via"] as? String, "widget")
        transport.queueTimelineFailure()
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        guard case .clear = firstContent(plan) else { return XCTFail("the pressed task stays hidden while offline") }
    }

    func testPressWithoutSignalStaysQueuedAndIsReplayedInOrder() async throws {
        transport.queueTimeline(200, body: try Fixture.data("three-step-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        transport.queueConfirmFailure()
        let first = await makeSync().pressDone(instanceId: "inst-tea", step: 0, via: .widget)
        clock.advance(5)
        transport.queueConfirmFailure()
        let second = await makeSync().pressDone(instanceId: "inst-tea", step: 1, via: .widget)
        XCTAssertEqual([first, second], [.pending, .pending])
        XCTAssertEqual(queue.pending().map(\.step), [0, 1])
        XCTAssertEqual(transport.confirmBodies.map { $0["step"] as? Int }, [0, 0])

        transport.queueTimelineFailure()
        let offlinePlan = await makeSync().refresh(locale: Fixture.unitedStates)
        guard case .due(let shown) = firstContent(offlinePlan) else { return XCTFail("expected the third step") }
        XCTAssertEqual(shown.step, 2)

        XCTAssertEqual(queue.pending().map(\.step), [0, 1])

        clock.advance(60)
        let confirmed = try Fixture.json(["status": "confirmed", "reason": NSNull(), "state": NSNull()])
        transport.queueConfirm(200, body: confirmed)
        transport.queueConfirm(200, body: confirmed)
        transport.queueTimeline(200, body: try Fixture.data("three-step-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        let replayed = transport.confirmBodies.suffix(2)
        XCTAssertEqual(replayed.map { $0["step"] as? Int }, [0, 1])
        XCTAssertEqual(replayed.map { $0["pressedAgoMs"] as? Int }, [65_000, 60_000])
        XCTAssertEqual(queue.pending(), [])
    }

    func testAPressAnsweredAfterTheFetchStartedStaysHidden() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        try queue.append(Press(instanceId: "inst-old", step: 0, via: .widget, pressedAt: clock.now))
        let confirmed = try Fixture.json(["status": "confirmed", "reason": NSNull(), "state": NSNull()])
        let appProcess = makeSync()
        let widgetProcess = makeSync()
        let clock = self.clock!
        let directory = self.directory!
        transport.beforeReply(to: "/device/confirm") {
            clock.advance(1)
            try? PressQueue(directory: directory).append(
                Press(instanceId: "inst-morning-pills", step: 0, via: .liveActivity, pressedAt: clock.now)
            )
            clock.advance(1)
        }
        transport.queueConfirm(200, body: confirmed)
        transport.beforeReply(to: "/device/timeline") {
            clock.advance(1)
            _ = await appProcess.replayPresses(timeout: 1)
        }
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        transport.queueConfirm(200, body: confirmed)
        let plan = await widgetProcess.refresh(locale: Fixture.unitedStates)
        XCTAssertEqual(queue.pending(), [])
        guard case .clear = firstContent(plan) else {
            return XCTFail("a timeline the server built before it applied the press shows the task as due again")
        }
        clock.advance(10)
        transport.queueTimeline(200, body: try Fixture.data("all-done"))
        let later = await makeSync().refresh(locale: Fixture.unitedStates)
        XCTAssertEqual(queue.pressed(), [])
        guard case .clear = firstContent(later) else { return XCTFail("the next fetch shows the server's day") }
    }

    func testRefusedPressIsDroppedAndTheTaskReturnsWithTheFreshTimeline() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        transport.queueConfirm(200, body: try Fixture.json(["status": "rejected", "reason": "No such task", "state": NSNull()]))
        _ = await makeSync().pressDone(instanceId: "inst-morning-pills", step: 0, via: .widget)
        XCTAssertEqual(queue.pending(), [])
        clock.advance(10)
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        guard case .due(let due) = firstContent(plan) else { return XCTFail("the refused task shows again") }
        XCTAssertEqual(due.instanceId, "inst-morning-pills")
    }

    func testAServerErrorHoldsBackOnlyTheLaterPressesOfItsOwnTask() async throws {
        let start = clock.now
        for (offset, instance, step) in [(0.0, "inst-a", 0), (1, "inst-b", 0), (2, "inst-a", 1), (3, "inst-c", 0)] {
            try queue.append(Press(instanceId: instance, step: step, via: .widget, pressedAt: start.addingTimeInterval(offset)))
        }
        let confirmed = try Fixture.json(["status": "confirmed", "reason": NSNull(), "state": NSNull()])
        transport.queueConfirm(500)
        transport.queueConfirm(200, body: confirmed)
        transport.queueConfirm(200, body: confirmed)
        let result = await makeSync().replayPresses(timeout: 4)
        XCTAssertEqual(result, .pending)
        XCTAssertEqual(
            transport.confirmBodies.map { "\($0["instanceId"] as? String ?? "")/\($0["step"] as? Int ?? -1)" },
            ["inst-a/0", "inst-b/0", "inst-c/0"]
        )
        XCTAssertEqual(queue.pending().map(\.step), [0, 1])
        XCTAssertEqual(Set(queue.pending().map(\.instanceId)), ["inst-a"])
    }

    func testNoNetworkOrARateLimitStopsTheWholeReplay() async throws {
        let start = clock.now
        try queue.append(Press(instanceId: "inst-a", step: 0, via: .widget, pressedAt: start))
        try queue.append(Press(instanceId: "inst-b", step: 0, via: .widget, pressedAt: start.addingTimeInterval(1)))
        transport.queueConfirmFailure()
        let offline = await makeSync().replayPresses(timeout: 4)
        transport.queueConfirm(429, headers: ["Retry-After": "60"])
        let limited = await makeSync().replayPresses(timeout: 4)
        XCTAssertEqual([offline, limited], [.pending, .pending])
        XCTAssertEqual(transport.confirmBodies.compactMap { $0["instanceId"] as? String }, ["inst-a", "inst-a"])
        XCTAssertEqual(queue.pending().count, 2)
    }

    func testAReplayStopsWhenItsTimeIsUp() async throws {
        let start = clock.now
        for offset in 0..<3 {
            try queue.append(Press(instanceId: "inst-\(offset)", step: 0, via: .widget, pressedAt: start.addingTimeInterval(TimeInterval(offset))))
        }
        let clock = self.clock!
        for _ in 0..<3 {
            transport.beforeReply(to: "/device/confirm") { clock.advance(3) }
            transport.queueConfirm(503)
        }
        let result = await makeSync().replayPresses(timeout: 4)
        XCTAssertEqual(result, .pending)
        XCTAssertEqual(transport.confirmBodies.compactMap { $0["instanceId"] as? String }, ["inst-0", "inst-1"])
    }

    func testUnreadablePressIsDropped() async throws {
        transport.queueConfirm(400)
        let result = await makeSync().pressDone(instanceId: "inst", step: 0, via: .widget)
        XCTAssertEqual(result, .clean)
        XCTAssertEqual(queue.pending(), [])
    }

    func testUnauthorizedPressStaysQueuedAndDropsTheToken() async throws {
        transport.queueConfirm(401)
        let result = await makeSync().pressDone(instanceId: "inst", step: 0, via: .widget)
        XCTAssertEqual(result, .unauthorized)
        XCTAssertEqual(queue.pending().map(\.instanceId), ["inst"])
        XCTAssertNil(tokens.read())
    }

    func testPressWithoutCredentialsIsKeptForLater() async throws {
        tokens = MemoryTokenStore(nil)
        let result = await makeSync().pressDone(instanceId: "inst", step: 0, via: .widget)
        XCTAssertEqual(result, .noCredentials)
        XCTAssertEqual(queue.pending().map(\.instanceId), ["inst"])
    }

    func testRateLimitedRefreshWaitsForRetryAfter() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        transport.queueTimeline(429, headers: ["Retry-After": "3600"])
        let plan = await makeSync().refresh(locale: Fixture.unitedStates)
        XCTAssertEqual(plan.reloadAt, clock.now.addingTimeInterval(3600))
    }

    func testTwoWritersAppendThenOneDrainSendsEachPressOnce() async throws {
        let first = PressQueue(directory: directory)
        let second = PressQueue(directory: directory)
        let start = clock.now
        DispatchQueue.concurrentPerform(iterations: 40) { index in
            let writer = index % 2 == 0 ? first : second
            try? writer.append(
                Press(instanceId: "inst-\(index)", step: 0, via: .widget, pressedAt: start.addingTimeInterval(TimeInterval(index)))
            )
        }
        clock.advance(60)
        let confirmed = try Fixture.json(["status": "confirmed", "reason": NSNull(), "state": NSNull()])
        for _ in 0..<40 { transport.queueConfirm(200, body: confirmed) }
        let result = await makeSync().replayPresses(timeout: 1)
        XCTAssertEqual(result, .clean)
        XCTAssertEqual(transport.confirmBodies.compactMap { $0["instanceId"] as? String }, (0..<40).map { "inst-\($0)" })
        XCTAssertEqual(queue.pending(), [])
    }

    func testStoredSiteURLRequiresAToken() throws {
        let sync = makeSync()
        XCTAssertEqual(sync.storedSiteURL()?.absoluteString, "https://example.convex.site")
        tokens = MemoryTokenStore(nil)
        XCTAssertNil(makeSync().storedSiteURL())
    }

    func testClearRemovesCredentialsCacheAndPresses() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        try queue.append(Press(instanceId: "inst", step: 0, via: .widget, pressedAt: clock.now))
        let removed = try await makeSync().clear()
        XCTAssertTrue(removed)
        XCTAssertNil(tokens.read())
        XCTAssertNil(sites.read())
        XCTAssertNil(WidgetStorage(directory: directory).loadCache())
        XCTAssertEqual(queue.pending(), [])
        let removedAgain = try await makeSync().clear()
        XCTAssertFalse(removedAgain)
    }

    func testClearSendsQueuedPressesWithTheOldTokenBeforeItForgetsThem() async throws {
        let start = clock.now
        try queue.append(Press(instanceId: "inst-a", step: 0, via: .widget, pressedAt: start))
        try queue.append(Press(instanceId: "inst-b", step: 0, via: .liveActivity, pressedAt: start.addingTimeInterval(1)))
        transport.queueConfirm(200, body: try Fixture.json(["status": "confirmed", "reason": NSNull(), "state": NSNull()]))
        transport.queueConfirmFailure()
        let removed = try await makeSync().clear()
        XCTAssertTrue(removed)
        XCTAssertEqual(transport.confirmBodies.compactMap { $0["instanceId"] as? String }, ["inst-a", "inst-b"])
        XCTAssertEqual(transport.requests.first?.headers["Authorization"], "Bearer token-1")
        XCTAssertNil(tokens.read())
        XCTAssertEqual(queue.pending(), [])
    }

    func testStoreCredentialsWritesTokenAndSite() throws {
        tokens = MemoryTokenStore(nil)
        sites = MemorySiteStore(nil)
        let site = try XCTUnwrap(URL(string: "https://other.convex.site"))
        try makeSync().storeCredentials(token: "token-9", siteURL: site)
        XCTAssertEqual(tokens.read(), "token-9")
        XCTAssertEqual(sites.read(), site)
    }

    func testTheLockScreenTellsTimeInTheHouseholdZoneOnceATimelineIsCached() async throws {
        XCTAssertEqual(makeSync().householdTimeZone(), .autoupdatingCurrent)
        var payload = try Fixture.object("due-task")
        payload["timezone"] = "Asia/Tokyo"
        transport.queueTimeline(200, body: try Fixture.json(payload))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        let zone = makeSync().householdTimeZone()
        XCTAssertEqual(zone.identifier, "Asia/Tokyo")
        let pressed = Sample.state(Sample.card(), closed: ActivityClosed(kind: .done, at: Fixture.generatedAt))
        let face = TaskActivityFace(state: pressed, isStale: false, timeZone: zone, locale: Fixture.unitedStates)
        guard case .receipt(_, let noted) = face else { return XCTFail("expected the receipt") }
        XCTAssertEqual(normalizedSpaces(noted), "Noted at 11:30 PM")
    }

    func testCachedPlanUsesNoNetwork() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        let before = transport.requests.count
        guard case .due = firstContent(makeSync().cachedPlan(locale: Fixture.unitedStates)) else {
            return XCTFail("expected the cached task")
        }
        XCTAssertEqual(transport.requests.count, before)
    }
}

final class RotatingTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?
    private let replacement: String

    init(first: String, afterRead replacement: String) {
        token = first
        self.replacement = replacement
    }

    func lookup() -> StoredToken {
        lock.lock()
        defer { lock.unlock() }
        let current = token
        token = replacement
        return current.map(StoredToken.present) ?? .absent
    }

    func write(_ token: String) throws {}

    func remove(ifEqualTo expected: String?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard expected == nil || expected == token else { return false }
        token = nil
        return true
    }

    var current: String? {
        lock.lock()
        defer { lock.unlock() }
        return token
    }
}
