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
        await TaskActivities.settle(.failed, in: store)
        await TaskActivities.settle(nil, in: store)
        XCTAssertEqual(store.calls, [])
        await TaskActivities.settle(.unauthorized, in: store)
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
        await TaskActivities.settle(.answered(PushStateReply(directives: [.end(key: "a", state: done)])), in: store)
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
