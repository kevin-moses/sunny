import Foundation
import XCTest

@testable import SunnyWidgetCore

final class FakeActivityStore: TaskActivityStore, @unchecked Sendable {
    enum Call: Equatable {
        case update(key: String, state: TaskActivityState, staleAt: Date?)
        case end(key: String, state: TaskActivityState, dismissal: ActivityDismissal)
    }

    private let lock = NSLock()
    private var activities: [ShownActivity]
    private(set) var calls: [Call] = []

    init(_ activities: [ShownActivity]) {
        self.activities = activities
    }

    func shown() -> [ShownActivity] {
        lock.lock()
        defer { lock.unlock() }
        return activities
    }

    func update(key: String, to state: TaskActivityState, staleAt: Date?) async {
        lock.lock()
        calls.append(.update(key: key, state: state, staleAt: staleAt))
        lock.unlock()
    }

    func end(key: String, with state: TaskActivityState, dismissal: ActivityDismissal) async {
        lock.lock()
        calls.append(.end(key: key, state: state, dismissal: dismissal))
        lock.unlock()
    }
}

func shownActivity(
    key: String,
    state: TaskActivityState,
    token: String? = nil,
    phase: ReportedActivityState = .active
) -> ShownActivity {
    ShownActivity(
        attributes: SunnyTaskAttributes(activityKey: key, instanceId: state.card.instanceId, receiptMs: 10_000),
        state: state,
        staleAt: Sample.endsAt,
        token: token,
        phase: phase
    )
}

final class TaskActivitiesTests: XCTestCase {
    private let now = Fixture.generatedAt.addingTimeInterval(minutes(11))

    func testAPressOnTheLastStepEndsWithTheReceiptForTheReceiptTime() async {
        let pills = Sample.state(Sample.card(instanceId: "inst-pills"))
        let store = FakeActivityStore([
            shownActivity(key: "a", state: pills),
            shownActivity(key: "b", state: Sample.tea),
        ])
        await TaskActivities.showPress(instanceId: "inst-pills", step: 0, at: now, in: store)
        XCTAssertEqual(
            store.calls,
            [
                .end(
                    key: "a",
                    state: Sample.state(Sample.card(instanceId: "inst-pills"), closed: ActivityClosed(kind: .done, at: now)),
                    dismissal: .after(now.addingTimeInterval(10))
                )
            ]
        )
    }

    func testAPressOnAnEarlierStepUpdatesToTheNextStepAndKeepsTheStaleDate() async {
        let store = FakeActivityStore([shownActivity(key: "b", state: Sample.tea)])
        await TaskActivities.showPress(instanceId: "inst-tea", step: 0, at: now, in: store)
        guard case .update(let key, let state, let staleAt) = store.calls.first, store.calls.count == 1 else {
            return XCTFail("expected one update, got \(store.calls)")
        }
        XCTAssertEqual(key, "b")
        XCTAssertEqual(state.card.step, 1)
        XCTAssertEqual(staleAt, Sample.endsAt)
    }

    func testAPressOnAStepTheActivityNoLongerShowsLeavesItAlone() async {
        let store = FakeActivityStore([shownActivity(key: "b", state: Sample.tea)])
        await TaskActivities.showPress(instanceId: "inst-tea", step: 2, at: now, in: store)
        XCTAssertEqual(store.calls, [])
    }

    func testDirectivesUpdateAndEndOnlyActivitiesOnThePhone() async {
        let advanced = Sample.state(Sample.tea.card.advanced(stepText: "Pour."), nextSteps: [])
        let done = Sample.state(closed: ActivityClosed(kind: .done, at: now))
        let store = FakeActivityStore([
            shownActivity(key: "a", state: Sample.state()),
            shownActivity(key: "b", state: Sample.tea),
        ])
        await TaskActivities.apply(
            [
                .update(key: "b", state: advanced, staleAt: Sample.endsAt),
                .end(key: "a", state: done),
                .end(key: "gone", state: done),
            ],
            to: store
        )
        XCTAssertEqual(
            store.calls,
            [
                .update(key: "b", state: advanced, staleAt: Sample.endsAt),
                .end(key: "a", state: done, dismissal: .immediate),
            ]
        )
    }

    func testEndAllEndsEveryActivityAtOnce() async {
        let store = FakeActivityStore([
            shownActivity(key: "a", state: Sample.state()),
            shownActivity(key: "b", state: Sample.tea),
        ])
        await TaskActivities.endAll(in: store)
        XCTAssertEqual(
            store.calls,
            [
                .end(key: "a", state: Sample.state(), dismissal: .immediate),
                .end(key: "b", state: Sample.tea, dismissal: .immediate),
            ]
        )
    }

    func testTheReportListsEveryActivityWithItsTokenAndState() throws {
        let store = FakeActivityStore([
            shownActivity(key: "a", state: Sample.state(), token: "aa01", phase: .active),
            shownActivity(key: "b", state: Sample.tea, token: nil, phase: .dismissed),
        ])
        let report = TaskActivities.report(
            startToken: "ff00",
            enabled: true,
            store: store,
            widgetPush: WidgetPushReport(token: "0b0c")
        )
        XCTAssertEqual(
            String(decoding: try report.encoded(), as: UTF8.self),
            #"{"activities":[{"key":"a","state":"active","token":"aa01"},{"key":"b","state":"dismissed","token":null}],"#
                + #""liveActivityStart":{"enabled":true,"token":"ff00"},"widgetPush":{"token":"0b0c"}}"#
        )
    }

    func testAnAbsentSectionIsLeftOutAndTheClearedReportEmptiesEverySection() throws {
        let widgetOnly = PushStateReport(liveActivityStart: nil, activities: nil, widgetPush: WidgetPushReport(token: "0b"))
        XCTAssertEqual(String(decoding: try widgetOnly.encoded(), as: UTF8.self), #"{"widgetPush":{"token":"0b"}}"#)
        XCTAssertEqual(
            String(decoding: try PushStateReport.cleared.encoded(), as: UTF8.self),
            #"{"activities":[],"liveActivityStart":{"enabled":false,"token":null},"widgetPush":{"token":null}}"#
        )
    }

    func testTokensAreLowercaseHex() {
        XCTAssertEqual(Data([0x00, 0xAB, 0x10, 0xFF]).hexString, "00ab10ff")
    }
}

final class PushStateReplyTests: XCTestCase {
    private func contentJSON(step: Int = 0, closed: String = "null") -> String {
        """
        {"card":{"kind":"task","instanceId":"inst-tea","step":\(step),"stepCount":3,"stepText":null,"label":"Make tea",
        "sentence":null,"detail":null,"startsAt":1795098600000,"endsAt":1795102200000,"icon":"checklist"},
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
        XCTAssertEqual(ended.closed?.kind, .done)
    }

    func testDropsEntriesItCannotReadAndKeepsTheRest() {
        let body = """
            {"activities":[
            {"key":"x","directive":"restart","content":\(contentJSON())},
            {"key":"y","directive":"update","content":\(contentJSON())},
            {"key":"z","directive":"end","content":{"card":{}}},
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
        let reply = await makeSync().reportPushState(report)
        XCTAssertEqual(reply, PushStateReply(directives: []))
        let request = try XCTUnwrap(transport.pushStateRequests.first)
        XCTAssertEqual(request.method, "PUT")
        XCTAssertEqual(request.headers["Authorization"], "Bearer token-1")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(request.body, try report.encoded())
    }

    func testAnUnauthorizedReportDropsTheToken() async {
        transport.queuePushState(401)
        let reply = await makeSync().reportPushState(.cleared)
        XCTAssertNil(reply)
        XCTAssertNil(tokens.read())
    }

    func testAFailedReportKeepsTheTokenAndNothingIsQueued() async {
        transport.queuePushState(503)
        let first = await makeSync().reportPushState(.cleared)
        XCTAssertNil(first)
        XCTAssertEqual(tokens.read(), "token-1")
        let second = await makeSync().reportPushState(.cleared)
        XCTAssertNil(second)
        XCTAssertEqual(transport.pushStateRequests.count, 2)
    }

    func testWithoutCredentialsNothingIsSent() async {
        tokens = MemoryTokenStore(nil)
        let reply = await makeSync().reportPushState(.cleared)
        XCTAssertNil(reply)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testTheWidgetPushTokenIsStoredThenSentAloneAndSurvivesAClear() async throws {
        transport.queuePushState(503)
        let sync = makeSync()
        await sync.recordWidgetPush(token: "0b0c")
        XCTAssertEqual(transport.pushStateRequests.first?.json?.keys.sorted(), ["widgetPush"])
        XCTAssertEqual(sync.storedWidgetPush(), WidgetPushReport(token: "0b0c"))
        try sync.clear()
        XCTAssertEqual(makeSync().storedWidgetPush(), WidgetPushReport(token: "0b0c"))
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
        let lane = SyncLane { await gate.enter() }
        let first = Task { await lane.requestSync() }
        await waitUntil { await gate.entered == 1 }
        let later = (0..<5).map { _ in Task { await lane.requestSync() } }
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
        let lane = SyncLane { await log.add("sync") }
        await lane.requestSync()
        await lane.run { await log.add("clear") }
        await lane.requestSync()
        let entries = await log.entries
        XCTAssertEqual(entries, ["sync", "clear", "sync"])
    }
}
