import Foundation
import XCTest

@testable import SunnyWidgetCore

final class FakeActivityStore: TaskActivityStore, @unchecked Sendable {
    enum Call: Equatable {
        case update(id: String, state: TaskActivityState, staleAt: Date?)
        case end(id: String, state: TaskActivityState, dismissal: ActivityDismissal)
    }

    private let lock = NSLock()
    private var activities: [ShownActivity]
    private var recorded: [Call] = []

    init(_ activities: [ShownActivity]) {
        self.activities = activities
    }

    var calls: [Call] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func shown() -> [ShownActivity] {
        lock.lock()
        defer { lock.unlock() }
        return activities
    }

    func update(id: String, to state: TaskActivityState, staleAt: Date?) async {
        change(id, .update(id: id, state: state, staleAt: staleAt)) { old in
            shownActivity(id: id, key: old.key, state: state, staleAt: staleAt, token: old.token, phase: old.phase)
        }
    }

    func end(id: String, with state: TaskActivityState, dismissal: ActivityDismissal) async {
        change(id, .end(id: id, state: state, dismissal: dismissal)) { old in
            shownActivity(id: id, key: old.key, state: state, staleAt: old.staleAt, token: old.token, phase: .ended)
        }
    }

    private func change(_ id: String, _ call: Call, _ next: (ShownActivity) -> ShownActivity) {
        lock.lock()
        defer { lock.unlock() }
        recorded.append(call)
        activities = activities.map { $0.id == id ? next($0) : $0 }
    }
}

func shownActivity(
    id: String? = nil,
    key: String,
    state: TaskActivityState,
    staleAt: Date? = Sample.endsAt,
    token: String? = nil,
    phase: ReportedActivityState = .active
) -> ShownActivity {
    ShownActivity(
        id: id ?? "id-\(key)",
        attributes: SunnyTaskAttributes(activityKey: key, instanceId: state.card.instanceId, receiptMs: 10_000),
        state: state,
        staleAt: staleAt,
        token: token,
        phase: phase
    )
}

final class TaskActivitiesTests: XCTestCase {
    private let now = Fixture.generatedAt.addingTimeInterval(minutes(11))
    private let pills = Sample.state(Sample.card(instanceId: "inst-pills"))
    private var done: TaskActivityState { Sample.state(closed: ActivityClosed(kind: .done, at: now)) }
    private var advancedTea: TaskActivityState {
        Sample.state(Sample.tea.card.advanced(stepText: "Pour."), nextSteps: [])
    }

    func testAPressOnTheLastStepEndsWithTheReceiptForTheReceiptTime() async {
        let store = FakeActivityStore([shownActivity(key: "a", state: pills), shownActivity(key: "b", state: Sample.tea)])
        await TaskActivities.showPress(instanceId: "inst-pills", step: 0, at: now, in: store)
        let receipt = Sample.state(Sample.card(instanceId: "inst-pills"), closed: ActivityClosed(kind: .done, at: now))
        XCTAssertEqual(store.calls, [.end(id: "id-a", state: receipt, dismissal: .after(now.addingTimeInterval(10)))])
    }

    func testAPressOnAnEarlierStepUpdatesToTheNextStepAndKeepsTheStaleDate() async {
        let store = FakeActivityStore([shownActivity(key: "b", state: Sample.tea)])
        await TaskActivities.showPress(instanceId: "inst-tea", step: 0, at: now, in: store)
        guard case .update(let id, let state, let staleAt) = store.calls.first, store.calls.count == 1 else {
            return XCTFail("expected one update, got \(store.calls)")
        }
        XCTAssertEqual(id, "id-b")
        XCTAssertEqual(state.card.step, 1)
        XCTAssertEqual(staleAt, Sample.endsAt)
    }

    func testAPressOnAStepTheActivityNoLongerShowsLeavesItAlone() async {
        let store = FakeActivityStore([shownActivity(key: "b", state: Sample.tea)])
        await TaskActivities.showPress(instanceId: "inst-tea", step: 2, at: now, in: store)
        XCTAssertEqual(store.calls, [])
    }

    func testDirectivesUpdateAndEndOnlyActivitiesOnScreen() async {
        let store = FakeActivityStore([
            shownActivity(key: "a", state: Sample.state()),
            shownActivity(key: "b", state: Sample.tea),
            shownActivity(key: "c", state: Sample.state(), phase: .dismissed),
        ])
        await TaskActivities.apply(
            [
                .update(key: "b", state: advancedTea, staleAt: Sample.endsAt),
                .end(key: "a", state: done),
                .end(key: "c", state: done),
                .end(key: "gone", state: done),
            ],
            to: store
        )
        XCTAssertEqual(
            store.calls,
            [
                .update(id: "id-b", state: advancedTea, staleAt: Sample.endsAt),
                .end(id: "id-a", state: done, dismissal: .immediate),
            ]
        )
    }

    func testAnEndWithoutContentEndsTheActivityWithWhatItShows() async {
        let store = FakeActivityStore([shownActivity(key: "old", state: Sample.tea)])
        await TaskActivities.apply([.end(key: "old", state: nil)], to: store)
        XCTAssertEqual(store.calls, [.end(id: "id-old", state: Sample.tea, dismissal: .immediate)])
    }

    func testTheSameDirectivesTwiceChangeNothingTheSecondTime() async {
        let directives: [ActivityDirective] = [
            .update(key: "b", state: advancedTea, staleAt: Sample.endsAt),
            .end(key: "a", state: done),
        ]
        let store = FakeActivityStore([shownActivity(key: "a", state: pills), shownActivity(key: "b", state: Sample.tea)])
        await TaskActivities.apply(directives, to: store)
        await TaskActivities.apply(directives, to: store)
        XCTAssertEqual(store.calls.count, 2)
    }

    func testASecondActivityWithTheSameKeyIsEndedAndTheFirstKept() async {
        let store = FakeActivityStore([
            shownActivity(id: "first", key: "k", state: pills),
            shownActivity(key: "other", state: Sample.tea),
            shownActivity(id: "second", key: "k", state: pills),
        ])
        await TaskActivities.endDuplicates(in: store)
        XCTAssertEqual(store.calls, [.end(id: "second", state: pills, dismissal: .immediate)])
        await TaskActivities.endDuplicates(in: store)
        XCTAssertEqual(store.calls.count, 1)
    }

    func testAnUnauthorizedReportEndsEveryActivityAndAFailureEndsNone() async {
        let store = FakeActivityStore([shownActivity(key: "a", state: pills), shownActivity(key: "b", state: Sample.tea)])
        await TaskActivities.settle(.sent(.failed), in: store)
        await TaskActivities.settle(.credentialsUnreadable, in: store)
        XCTAssertEqual(store.calls, [])
        await TaskActivities.settle(.sent(.unauthorized), in: store)
        XCTAssertEqual(
            store.calls,
            [
                .end(id: "id-a", state: pills, dismissal: .immediate),
                .end(id: "id-b", state: Sample.tea, dismissal: .immediate),
            ]
        )
    }

    func testAnAnsweredReportAppliesItsDirectives() async {
        let store = FakeActivityStore([shownActivity(key: "a", state: pills)])
        await TaskActivities.settle(.sent(.answered(PushStateReply(directives: [.end(key: "a", state: done)]))), in: store)
        XCTAssertEqual(store.calls, [.end(id: "id-a", state: done, dismissal: .immediate)])
    }

    func testEndAllEndsEveryActivityOnScreenAtOnce() async {
        let store = FakeActivityStore([
            shownActivity(key: "a", state: Sample.state()),
            shownActivity(key: "b", state: Sample.tea, phase: .stale),
            shownActivity(key: "c", state: Sample.tea, phase: .ended),
        ])
        await TaskActivities.endAll(in: store)
        XCTAssertEqual(
            store.calls,
            [
                .end(id: "id-a", state: Sample.state(), dismissal: .immediate),
                .end(id: "id-b", state: Sample.tea, dismissal: .immediate),
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

    func testTheReportListsAKeyOnceAndPrefersTheActivityOnScreen() {
        let store = FakeActivityStore([
            shownActivity(id: "ended", key: "k", state: pills, phase: .ended),
            shownActivity(id: "live", key: "k", state: pills, token: "aa", phase: .active),
        ])
        let report = TaskActivities.report(startToken: nil, enabled: true, store: store, widgetPush: nil)
        XCTAssertEqual(report.activities, [ActivityReport(key: "k", token: "aa", state: .active)])
    }

    func testTheReportListsAtMostEightActivitiesOnScreenFirst() {
        let ended = (0..<6).map { shownActivity(key: "e\($0)", state: pills, phase: .ended) }
        let open = (0..<3).map { shownActivity(key: "o\($0)", state: pills) }
        let report = TaskActivities.report(
            startToken: nil,
            enabled: true,
            store: FakeActivityStore(ended + open),
            widgetPush: nil
        )
        XCTAssertEqual(report.activities?.count, 8)
        XCTAssertEqual(report.activities?.prefix(3).map(\.key), ["o0", "o1", "o2"])
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

final class ActivityPressTests: XCTestCase {
    private var directory: URL!
    private var transport: FakeTransport!
    private var tokens: MemoryTokenStore!
    private let now = Fixture.generatedAt.addingTimeInterval(minutes(11))

    override func setUpWithError() throws {
        directory = try temporaryDirectory()
        transport = FakeTransport()
        tokens = MemoryTokenStore("token-1")
    }

    private func makeSync() -> WidgetSync {
        let now = self.now
        return WidgetSync(
            storage: WidgetStorage(directory: directory),
            tokens: tokens,
            sites: MemorySiteStore(URL(string: "https://example.convex.site")),
            transport: transport,
            clock: { now }
        )
    }

    private func pills() -> FakeActivityStore {
        FakeActivityStore([shownActivity(key: "a", state: Sample.state(Sample.card(instanceId: "inst-pills")))])
    }

    func testTheReceiptShowsBeforeThePressIsSent() async throws {
        let store = pills()
        let receiptBeforeSend = LockedFlag()
        transport.beforeReply(to: "/device/confirm") {
            receiptBeforeSend.set(store.shown().first?.phase == .ended)
        }
        transport.queueConfirm(200, body: try Fixture.json(["status": "confirmed", "reason": NSNull(), "state": NSNull()]))
        let result = await makeSync().pressDoneOnActivity(instanceId: "inst-pills", step: 0, in: store)
        XCTAssertEqual(result, .clean)
        XCTAssertTrue(receiptBeforeSend.value, "the senior waited for the network before seeing the receipt")
        XCTAssertEqual(store.shown().first?.state.closed, ActivityClosed(kind: .done, at: now))
    }

    func testAPressThatCouldNotBeStoredOrSentShowsNoReceipt() async throws {
        try Data().write(to: directory.appendingPathComponent("marks"))
        let store = pills()
        transport.queueConfirmFailure()
        let result = await makeSync().pressDoneOnActivity(instanceId: "inst-pills", step: 0, in: store)
        XCTAssertEqual(result, .pending)
        XCTAssertEqual(store.calls, [])
    }

    func testAnUnauthorizedPressEndsEveryActivity() async throws {
        let store = FakeActivityStore([
            shownActivity(key: "a", state: Sample.state(Sample.card(instanceId: "inst-pills"))),
            shownActivity(key: "b", state: Sample.tea),
        ])
        transport.queueConfirm(401)
        let result = await makeSync().pressDoneOnActivity(instanceId: "inst-pills", step: 0, in: store)
        XCTAssertEqual(result, .unauthorized)
        XCTAssertTrue(store.shown().allSatisfy { $0.phase == .ended })
    }

    func testAnUnpairedPhoneEndsEveryActivityShowsNoReceiptAndKeepsNoPress() async throws {
        tokens = MemoryTokenStore(nil)
        let store = FakeActivityStore([
            shownActivity(key: "a", state: Sample.state(Sample.card(instanceId: "inst-pills"))),
            shownActivity(key: "b", state: Sample.tea),
        ])
        let sync = makeSync()
        let result = await sync.pressDoneOnActivity(instanceId: "inst-pills", step: 0, in: store)
        XCTAssertEqual(result, .noCredentials)
        XCTAssertTrue(store.shown().allSatisfy { $0.phase == .ended })
        XCTAssertTrue(store.shown().allSatisfy { $0.state.closed == nil }, "a receipt for a press nobody will receive")
        XCTAssertEqual(sync.unsentPresses(), [])
        XCTAssertTrue(transport.confirmBodies.isEmpty)
    }

    func testAPressBeforeTheFirstUnlockIsKeptWithItsReceipt() async throws {
        let store = pills()
        let sync = WidgetSync(
            storage: WidgetStorage(directory: directory),
            tokens: LockedKeychainTokenStore(),
            sites: MemorySiteStore(URL(string: "https://example.convex.site")),
            transport: transport,
            clock: { [now] in now }
        )
        let result = await sync.pressDoneOnActivity(instanceId: "inst-pills", step: 0, in: store)
        XCTAssertEqual(result, .noCredentials)
        XCTAssertEqual(store.shown().first?.state.closed, ActivityClosed(kind: .done, at: now))
        XCTAssertEqual(sync.unsentPresses().map(\.key), [PressKey(instanceId: "inst-pills", step: 0)])
    }
}

final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var current = false

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func set(_ value: Bool) {
        lock.lock()
        current = value
        lock.unlock()
    }
}

final class AppPressTests: XCTestCase {
    private var directory: URL!
    private var transport: FakeTransport!
    private var clock: TestClock!
    private let appPressId = UUID()

    override func setUpWithError() throws {
        directory = try temporaryDirectory()
        transport = FakeTransport()
        clock = TestClock(Fixture.generatedAt.addingTimeInterval(minutes(1)))
    }

    private func makeSync() -> WidgetSync {
        let clock = self.clock!
        return WidgetSync(
            storage: WidgetStorage(directory: directory),
            tokens: MemoryTokenStore("token-1"),
            sites: MemorySiteStore(URL(string: "https://example.convex.site")),
            transport: transport,
            clock: { clock.now }
        )
    }

    private func pills() -> FakeActivityStore {
        FakeActivityStore([shownActivity(key: "a", state: Sample.state(Sample.card(instanceId: "inst-morning-pills")))])
    }

    private func shown(_ plan: TimelinePlan) -> WidgetContent? { plan.entries.first?.content }

    private func pressInApp(_ store: TaskActivityStore) async throws {
        try await makeSync().markAppPress(
            id: appPressId,
            instanceId: "inst-morning-pills",
            step: 0,
            pressedAt: clock.now,
            in: store
        )
    }

    func testAnAppPressHidesTheCardOnTheWidgetAndShowsTheReceiptOnTheLockScreen() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        let store = pills()
        try await pressInApp(store)
        guard case .clear = shown(makeSync().cachedPlan(locale: Fixture.unitedStates)) else {
            return XCTFail("the widget shows a task the app already marked done")
        }
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        guard case .clear = shown(await makeSync().refresh(locale: Fixture.unitedStates)) else {
            return XCTFail("a fetch before the app's press reached the server shows it due again")
        }
        XCTAssertEqual(store.shown().first?.state.closed?.kind, .done)
        XCTAssertEqual(makeSync().unsentPresses(), [])
    }

    func testAnUndoInTheAppShowsTheCardAgain() async throws {
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        _ = await makeSync().refresh(locale: Fixture.unitedStates)
        try await pressInApp(pills())
        makeSync().withdrawAppPress(id: appPressId)
        guard case .due = shown(makeSync().cachedPlan(locale: Fixture.unitedStates)) else {
            return XCTFail("the undone task is due again")
        }
    }

    func testTheMarkGoesWithTheFirstFetchAfterTheServerAnsweredTheApp() async throws {
        try await pressInApp(pills())
        makeSync().answerAppPress(id: appPressId)
        clock.advance(1)
        transport.queueTimeline(200, body: try Fixture.data("due-task"))
        guard case .due = shown(await makeSync().refresh(locale: Fixture.unitedStates)) else {
            return XCTFail("the server's own answer decides once it has the press")
        }
    }

    func testTheAppSeesPressesTheWidgetAndTheLockScreenHaveNotSent() async throws {
        transport.queueConfirmFailure()
        _ = await makeSync().pressDone(instanceId: "inst-morning-pills", step: 0, via: .widget)
        XCTAssertEqual(makeSync().unsentPresses().map(\.key), [PressKey(instanceId: "inst-morning-pills", step: 0)])
    }
}
