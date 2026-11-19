import Foundation
import XCTest

@testable import SunnyWidgetCore

final class ReloadPolicyTests: XCTestCase {
    private let start = Fixture.generatedAt

    func testAsksAgainSoonWhileATaskShows() throws {
        let timeline = try Fixture.timeline("due-task")
        XCTAssertEqual(
            ReloadPolicy.nextReload(after: start, timeline: timeline, pressed: []),
            start.addingTimeInterval(minutes(15))
        )
    }

    func testAsksAgainSoonWhenATaskShowsWithinTheHour() throws {
        let timeline = try Fixture.timeline("nothing-due-next")
        let lunch = Date(timeIntervalSince1970: 1_795_109_400)
        let now = lunch.addingTimeInterval(-minutes(50))
        XCTAssertEqual(ReloadPolicy.nextReload(after: now, timeline: timeline, pressed: []), now.addingTimeInterval(minutes(15)))
    }

    func testAsksAgainCalmlyWhenNoTaskIsNear() throws {
        let timeline = try Fixture.timeline("nothing-due-next")
        let lunch = Date(timeIntervalSince1970: 1_795_109_400)
        let now = lunch.addingTimeInterval(-minutes(90))
        XCTAssertEqual(ReloadPolicy.nextReload(after: now, timeline: timeline, pressed: []), now.addingTimeInterval(minutes(60)))
    }

    func testPressedTasksDoNotCountAsShowing() throws {
        let timeline = try Fixture.timeline("due-task")
        let pressed: Set = [PressKey(instanceId: "inst-morning-pills", step: 0)]
        XCTAssertEqual(
            ReloadPolicy.nextReload(after: start, timeline: timeline, pressed: pressed),
            start.addingTimeInterval(minutes(60))
        )
    }

    func testNeverLaterThanTwoHoursBeforeUntil() throws {
        let timeline = try Fixture.timeline("empty-day")
        let now = timeline.until.addingTimeInterval(-minutes(150))
        XCTAssertEqual(
            ReloadPolicy.nextReload(after: now, timeline: timeline, pressed: []),
            timeline.until.addingTimeInterval(-minutes(120))
        )
    }

    func testInsideTheRenewalWindowAsksAgainSoon() throws {
        let timeline = try Fixture.timeline("empty-day")
        let now = timeline.until.addingTimeInterval(-minutes(30))
        XCTAssertEqual(ReloadPolicy.nextReload(after: now, timeline: timeline, pressed: []), now.addingTimeInterval(minutes(15)))
        XCTAssertTrue(ReloadPolicy.needsRenewal(timeline, at: now))
        XCTAssertFalse(ReloadPolicy.needsRenewal(timeline, at: start))
    }

    func testWithoutATimelineAsksAgainCalmly() {
        XCTAssertEqual(ReloadPolicy.nextReload(after: start, timeline: nil, pressed: []), start.addingTimeInterval(minutes(60)))
    }

    func testHonoursRetryAfter() throws {
        let timeline = try Fixture.timeline("due-task")
        let later = start.addingTimeInterval(minutes(40))
        XCTAssertEqual(ReloadPolicy.nextReload(after: start, timeline: timeline, pressed: [], notBefore: later), later)
    }
}

final class TimelinePlannerTests: XCTestCase {
    private let start = Fixture.generatedAt

    func testPlansAnEntryPerSliceAndANoticeAtUntil() throws {
        let timeline = try Fixture.timeline("due-task")
        let plan = TimelinePlanner.plan(at: start, timeline: timeline, pressed: [], locale: Fixture.unitedStates)
        XCTAssertEqual(plan.entries.map(\.date), [start, Date(timeIntervalSince1970: 1_795_105_800), timeline.until])
        guard case .due = plan.entries[0].content else { return XCTFail("expected due first") }
        guard case .clear = plan.entries[1].content else { return XCTFail("expected clear second") }
        XCTAssertEqual(plan.entries[2].content, .notice(.notConnected))
    }

    func testLeavesOutAnEntryThatShowsWhatTheOneBeforeShows() throws {
        let timeline = try Fixture.timeline("due-task")
        let pressed: Set = [PressKey(instanceId: "inst-morning-pills", step: 0)]
        let plan = TimelinePlanner.plan(at: start, timeline: timeline, pressed: pressed, locale: Fixture.unitedStates)
        XCTAssertEqual(plan.entries.map(\.date), [start, timeline.until])
        guard case .clear(let clear) = plan.entries[0].content else { return XCTFail("expected clear first") }
        XCTAssertEqual(clear.next?.label, "Lunch")
    }

    func testAppliesPressesToFutureEntries() throws {
        let timeline = try Fixture.timeline("nothing-due-next")
        let pressed: Set = [PressKey(instanceId: "inst-lunch", step: 0)]
        let plan = TimelinePlanner.plan(at: start, timeline: timeline, pressed: pressed, locale: Fixture.unitedStates)
        XCTAssertEqual(plan.entries[1].content, .clear(ClearContent(headline: "Everything is done.", next: nil)))
    }

    func testPastUntilShowsTheNoticeOnly() throws {
        let timeline = try Fixture.timeline("due-task")
        let plan = TimelinePlanner.plan(at: timeline.until, timeline: timeline, pressed: [], locale: Fixture.unitedStates)
        XCTAssertEqual(plan.entries, [PlannedEntry(date: timeline.until, content: .notice(.notConnected))])
    }

    func testWithoutATimelineShowsTheNotice() {
        let plan = TimelinePlanner.plan(at: start, timeline: nil, pressed: [], locale: Fixture.unitedStates)
        XCTAssertEqual(plan.entries, [PlannedEntry(date: start, content: .notice(.notConnected))])
    }
}
