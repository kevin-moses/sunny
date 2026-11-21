import Foundation
import XCTest

@testable import SunnyWidgetCore

final class PushStateReplyTests: XCTestCase {
    private func contentJSON(step: Int = 0, closed: String = "null") -> String {
        """
        {"card":{"instanceId":"inst-tea","step":\(step),"stepCount":3,"stepText":null,"label":"Make tea",
        "sentence":null,"detail":null,"icon":"checklist","startsAt":1795098600000,"endsAt":1795102200000},
        "nextSteps":[],"closed":\(closed)}
        """
    }

    func testReadsUpdateAndEndDirectives() {
        let body = """
            {"activities":[
            {"key":"b","directive":"update","content":\(contentJSON(step: 1)),"staleAt":1795102200000},
            {"key":"a","directive":"end","content":\(contentJSON(closed: #"{"kind":"done","at":1795099800000}"#))}
            ]}
            """
        let reply = PushStateReply.decode(Data(body.utf8))
        XCTAssertEqual(reply.directives.map(\.key), ["b", "a"])
        guard case .update(_, let state, let staleAt) = reply.directives[0] else { return XCTFail("expected update") }
        XCTAssertEqual(state.card.step, 1)
        XCTAssertEqual(staleAt, Sample.endsAt)
        guard case .end(_, let ended) = reply.directives[1] else { return XCTFail("expected end") }
        XCTAssertEqual(ended?.closed?.kind, .done)
    }

    func testAnEndForAKeyTheServerDoesNotKnowHasNoContent() {
        let body = #"{"activities":[{"key":"old","directive":"end","content":null}]}"#
        XCTAssertEqual(PushStateReply.decode(Data(body.utf8)).directives, [.end(key: "old", state: nil)])
    }

    func testDropsEntriesItCannotReadAndKeepsTheRest() {
        let body = """
            {"activities":[
            {"key":"x","directive":"restart","content":\(contentJSON())},
            {"key":"y","directive":"update","content":\(contentJSON())},
            {"key":"z","directive":"update","content":{"card":{}},"staleAt":1795102200000},
            {"directive":"end","content":null},
            {"key":"a","directive":"end","content":\(contentJSON())}
            ]}
            """
        XCTAssertEqual(PushStateReply.decode(Data(body.utf8)).directives.map(\.key), ["a"])
    }

    func testAnUnreadableBodyHasNoDirectives() {
        XCTAssertEqual(PushStateReply.decode(Data("nope".utf8)).directives, [])
        XCTAssertEqual(PushStateReply.decode(Data("{}".utf8)).directives, [])
    }
}

final class PushStateSyncTests: XCTestCase {
    private var directory: URL!
    private var transport: FakeTransport!
    private var tokens: MemoryTokenStore!

    override func setUpWithError() throws {
        directory = try temporaryDirectory()
        transport = FakeTransport()
        tokens = MemoryTokenStore("token-1")
    }

    private func makeSync() -> WidgetSync {
        WidgetSync(
            storage: WidgetStorage(directory: directory),
            tokens: tokens,
            sites: MemorySiteStore(URL(string: "https://example.convex.site")),
            transport: transport,
            clock: { Fixture.generatedAt }
        )
    }

    func testSendsTheReportAsAPutWithTheDeviceTokenAndReturnsTheDirectives() async throws {
        transport.queuePushState(200, body: Data(#"{"activities":[]}"#.utf8))
        let report = PushStateReport(
            liveActivityStart: StartTokenReport(token: "ff", enabled: true),
            activities: [],
            widgetPush: nil
        )
        let outcome = await makeSync().reportPushState(report)
        XCTAssertEqual(outcome, .sent(.answered(PushStateReply(directives: []))))
        let request = try XCTUnwrap(transport.pushStateRequests.first)
        XCTAssertEqual(request.method, "PUT")
        XCTAssertEqual(request.headers["Authorization"], "Bearer token-1")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(request.body, try report.encoded())
    }

    func testAnUnauthorizedReportDropsTheToken() async {
        transport.queuePushState(401)
        let outcome = await makeSync().reportPushState(.cleared)
        XCTAssertEqual(outcome, .sent(.unauthorized))
        XCTAssertNil(tokens.read())
    }

    func testAFailedReportKeepsTheTokenAndNothingIsQueued() async {
        transport.queuePushState(503)
        let first = await makeSync().reportPushState(.cleared)
        XCTAssertEqual(first, .sent(.failed))
        XCTAssertEqual(tokens.read(), "token-1")
        let second = await makeSync().reportPushState(.cleared)
        XCTAssertEqual(second, .sent(.failed))
        XCTAssertEqual(transport.pushStateRequests.count, 2)
    }

    func testWithoutCredentialsNothingIsSent() async {
        tokens = MemoryTokenStore(nil)
        let outcome = await makeSync().reportPushState(.cleared)
        XCTAssertEqual(outcome, .notPaired)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testAReportThatFindsTheTokenGoneEndsEveryActivity() async {
        tokens = MemoryTokenStore(nil)
        let store = FakeActivityStore([shownActivity(key: "a", state: Sample.tea)])
        await TaskActivities.settle(await makeSync().reportPushState(.cleared), in: store)
        XCTAssertEqual(store.shown().map(\.phase), [.ended])
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testAReportBeforeTheFirstUnlockEndsNothingAndSendsNothing() async {
        let store = FakeActivityStore([shownActivity(key: "a", state: Sample.tea)])
        let sync = WidgetSync(
            storage: WidgetStorage(directory: directory),
            tokens: LockedKeychainTokenStore(),
            sites: MemorySiteStore(URL(string: "https://example.convex.site")),
            transport: transport,
            clock: { Fixture.generatedAt }
        )
        let outcome = await sync.reportPushState(.cleared)
        XCTAssertEqual(outcome, .credentialsUnreadable)
        await TaskActivities.settle(outcome, in: store)
        XCTAssertEqual(store.shown().map(\.phase), [.active])
        XCTAssertTrue(transport.requests.isEmpty)
    }

    private func reloadsAfterReport(reloadingWidget: Bool) async -> Int {
        let reloads = ReloadCounter()
        let store = FakeActivityStore([shownActivity(key: "a", state: Sample.tea)])
        await makeSync().sendReport(
            startToken: nil,
            enabled: true,
            in: store,
            reloadingWidget: reloadingWidget,
            reloadWidget: { reloads.add() }
        )
        return reloads.count
    }

    func testAReportAnswered401ReloadsTheWidgetWhateverTheTrigger() async {
        transport.queuePushState(401)
        let reloads = await reloadsAfterReport(reloadingWidget: false)
        XCTAssertEqual(reloads, 1)
        let plan = makeSync().cachedPlan(locale: Fixture.unitedStates)
        XCTAssertEqual(plan.entries.first?.content, .notice(.openSunny))
    }

    func testAReportThatFindsNoCredentialsReloadsTheWidgetWhateverTheTrigger() async {
        tokens = MemoryTokenStore(nil)
        let reloads = await reloadsAfterReport(reloadingWidget: false)
        XCTAssertEqual(reloads, 1)
    }

    func testAnAnsweredOrFailedReportReloadsOnlyWhenItsTriggerAsks() async {
        transport.queuePushState(200, body: Data(#"{"activities":[]}"#.utf8))
        let answered = await reloadsAfterReport(reloadingWidget: false)
        transport.queuePushState(503)
        let failed = await reloadsAfterReport(reloadingWidget: false)
        transport.queuePushState(200, body: Data(#"{"activities":[]}"#.utf8))
        let asked = await reloadsAfterReport(reloadingWidget: true)
        XCTAssertEqual([answered, failed, asked], [0, 0, 1])
    }

    func testTheWidgetPushTokenIsStoredThenSentAloneAndSurvivesAClear() async throws {
        transport.queuePushState(503)
        let sync = makeSync()
        _ = await sync.reportPushState(sync.storeWidgetPush(token: "0b0c"))
        XCTAssertEqual(transport.pushStateRequests.first?.json?.keys.sorted(), ["widgetPush"])
        XCTAssertEqual(sync.storedWidgetPush(), WidgetPushReport(token: "0b0c"))
        try await sync.clear()
        XCTAssertEqual(makeSync().storedWidgetPush(), WidgetPushReport(token: "0b0c"))
    }
}

final class ReloadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var current = 0

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func add() {
        lock.lock()
        current += 1
        lock.unlock()
    }
}

final class RefreshPushTests: XCTestCase {
    func testTheBackgroundRefreshGoldenAsksForARefreshAndNoOtherPushDoes() throws {
        XCTAssertTrue(RefreshPush.matches(["aps": try PushFixture.aps(named: "background-refresh")]))
        for name in ["alert-reprompt", "widget-reload", "start", "end-done"] {
            XCTAssertFalse(RefreshPush.matches(["aps": try PushFixture.aps(named: name)]), name)
        }
        XCTAssertFalse(RefreshPush.matches(["kind": "senior_prompt"]))
    }
}

final class SyncLaneTests: XCTestCase {
    actor Gate {
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private(set) var entered = 0

        func enter() async {
            entered += 1
            await withCheckedContinuation { waiters.append($0) }
        }

        func openAll() {
            waiters.forEach { $0.resume() }
            waiters = []
        }
    }

    actor Log {
        private(set) var entries: [String] = []
        func add(_ entry: String) { entries.append(entry) }
    }

    private func waitUntil(_ condition: @escaping () async -> Bool) async {
        for _ in 0..<500 where !(await condition()) {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    func testRequestsDuringARunAreFoldedIntoOneMoreRun() async {
        let gate = Gate()
        let lane = SyncLane { _ in await gate.enter() }
        let first = Task { await lane.requestSync(.launch) }
        await waitUntil { await gate.entered == 1 }
        let later = (0..<5).map { _ in Task { await lane.requestSync(.activityChange) } }
        try? await Task.sleep(nanoseconds: 20_000_000)
        let opener = Task {
            while !Task.isCancelled {
                await gate.openAll()
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
        }
        await first.value
        for task in later { await task.value }
        opener.cancel()
        let runs = await gate.entered
        XCTAssertEqual(runs, 2)
    }

    func testWorkRunsInTheOrderItWasAsked() async {
        let log = Log()
        let lane = SyncLane { _ in await log.add("sync") }
        await lane.requestSync(.launch)
        let cleared = await lane.run { () -> Bool in
            await log.add("clear")
            return true
        }
        await lane.requestSync(.launch)
        let entries = await log.entries
        XCTAssertTrue(cleared)
        XCTAssertEqual(entries, ["sync", "clear", "sync"])
    }

    func testOnlyTriggersThatCanChangeTheWidgetReloadIt() {
        let reloading = SyncTrigger.allCases.filter(\.reloadsWidget)
        XCTAssertEqual(reloading, [.refreshPush, .appSurfaces, .press])
    }

    func testARunReloadsTheWidgetWhenAnyRequestFoldedIntoItAsked() async {
        let gate = Gate()
        let log = Log()
        let lane = SyncLane { reloading in
            await log.add(reloading ? "reload" : "report")
            await gate.enter()
        }
        let first = Task { await lane.requestSync(.startToken) }
        await waitUntil { await gate.entered == 1 }
        let later = [SyncTrigger.activityChange, .press, .enablement].map { trigger in
            Task { await lane.requestSync(trigger) }
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
        let opener = Task {
            while !Task.isCancelled {
                await gate.openAll()
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
        }
        await first.value
        for task in later { await task.value }
        await lane.requestSync(.activityChange)
        opener.cancel()
        let entries = await log.entries
        XCTAssertEqual(entries, ["report", "reload", "report"])
    }
}
