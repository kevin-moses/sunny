import Foundation
import XCTest

@testable import SunnyWidgetCore

final class CardSelectionTests: XCTestCase {
    private let start = Fixture.generatedAt

    func testPicksTheDueTask() throws {
        let timeline = try Fixture.timeline("due-task")
        guard case .task(let task) = timeline.pick(at: start.addingTimeInterval(minutes(5)), pressed: []) else {
            return XCTFail("expected the due task")
        }
        XCTAssertEqual(task.instanceId, "inst-morning-pills")
    }

    func testPicksTheClearCardOnceTheTaskIsPressed() throws {
        let timeline = try Fixture.timeline("due-task")
        let pressed: Set = [PressKey(instanceId: "inst-morning-pills", step: 0)]
        XCTAssertEqual(
            timeline.pick(at: start, pressed: pressed),
            .clear(ClearCard(allDone: false, next: NextItem(label: "Lunch", startsAt: Date(timeIntervalSince1970: 1_795_109_400))))
        )
    }

    func testFollowsTheSliceInForceAtEachInstant() throws {
        let timeline = try Fixture.timeline("due-task")
        let secondSlice = Date(timeIntervalSince1970: 1_795_105_800)
        guard case .task = timeline.pick(at: secondSlice.addingTimeInterval(-1), pressed: []) else {
            return XCTFail("the task holds until the next slice")
        }
        guard case .clear = timeline.pick(at: secondSlice, pressed: []) else {
            return XCTFail("the next slice starts at its at")
        }
    }

    func testPicksTheFirstUnpressedOfTwoDueTasks() throws {
        let timeline = try Fixture.timeline("two-due-tasks")
        let first = timeline.pick(at: start, pressed: [])
        let second = timeline.pick(at: start, pressed: [PressKey(instanceId: "inst-morning-pills", step: 0)])
        guard case .task(let a) = first, case .task(let b) = second else { return XCTFail("expected two tasks") }
        XCTAssertEqual(a.instanceId, "inst-morning-pills")
        XCTAssertEqual(b.instanceId, "inst-blood-pressure")
    }

    func testWalksTheStepsOfAMultiStepTask() throws {
        let timeline = try Fixture.timeline("three-step-task")
        var pressed: Set<PressKey> = []
        for step in 0..<3 {
            guard case .task(let task) = timeline.pick(at: start, pressed: pressed) else {
                return XCTFail("expected step \(step)")
            }
            XCTAssertEqual(task.step, step)
            pressed.insert(task.key)
        }
        XCTAssertEqual(timeline.pick(at: start, pressed: pressed), .clear(ClearCard(allDone: true, next: nil)))
    }

    func testIgnoresPressesOfOtherSteps() throws {
        let timeline = try Fixture.timeline("three-step-task")
        guard case .task(let task) = timeline.pick(at: start, pressed: [PressKey(instanceId: "inst-tea", step: 1)]) else {
            return XCTFail("expected a task")
        }
        XCTAssertEqual(task.step, 0)
    }

    func testUsesTheFirstSliceBeforeGeneratedAt() throws {
        let timeline = try Fixture.timeline("due-task")
        guard case .task = timeline.pick(at: start.addingTimeInterval(-60), pressed: []) else {
            return XCTFail("expected the first slice")
        }
    }

    func testPicksNothingFromUntilOn() throws {
        let timeline = try Fixture.timeline("due-task")
        XCTAssertNil(timeline.pick(at: timeline.until, pressed: []))
        XCTAssertNotNil(timeline.pick(at: timeline.until.addingTimeInterval(-1), pressed: []))
    }

    func testListsBoundariesAfterAnInstant() throws {
        let timeline = try Fixture.timeline("due-task")
        XCTAssertEqual(timeline.boundaries(after: start), [Date(timeIntervalSince1970: 1_795_105_800)])
        XCTAssertEqual(timeline.boundaries(after: Date(timeIntervalSince1970: 1_795_105_800)), [])
    }
}
