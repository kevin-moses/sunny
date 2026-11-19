import Foundation
import XCTest

@testable import SunnyWidgetCore

final class TimelineDecodingTests: XCTestCase {
    func testDecodesDueTaskAndIgnoresUnknownFields() throws {
        let timeline = try Fixture.timeline("due-task")
        XCTAssertEqual(timeline.version, "v-due-task")
        XCTAssertEqual(timeline.generatedAt, Fixture.generatedAt)
        XCTAssertEqual(timeline.until, Fixture.generatedAt.addingTimeInterval(24 * 3600))
        XCTAssertEqual(timeline.timeZone.identifier, "America/New_York")
        XCTAssertEqual(timeline.slices.count, 2)
        guard case .task(let task) = timeline.slices[0].cards[0] else { return XCTFail("expected a task card") }
        XCTAssertEqual(task.instanceId, "inst-morning-pills")
        XCTAssertEqual(task.label, "Morning pills")
        XCTAssertEqual(task.sentence, "Take your morning pills.")
        XCTAssertEqual(task.detail, "the small white ones")
        XCTAssertNil(task.stepText)
        XCTAssertEqual(task.startsAt, Fixture.generatedAt)
    }

    func testDecodesEveryFixture() throws {
        for name in ["due-task", "two-due-tasks", "three-step-task", "nothing-due-next", "all-done", "empty-day"] {
            XCTAssertNoThrow(try Fixture.timeline(name), name)
        }
    }

    func testDecodesClearCards() throws {
        let allDone = try Fixture.timeline("all-done")
        XCTAssertEqual(
            allDone.slices[0].cards,
            [.clear(ClearCard(allDone: true, next: NextItem(label: "Morning pills", startsAt: Date(timeIntervalSince1970: 1_795_179_600))))]
        )
        let empty = try Fixture.timeline("empty-day")
        XCTAssertEqual(empty.slices[0].cards, [.clear(ClearCard(allDone: false, next: nil))])
    }

    func testRejectsGarbage() {
        XCTAssertThrowsError(try DeviceTimeline.decode(Data("not json".utf8))) { error in
            XCTAssertEqual(error as? TimelineError, .unreadable)
        }
    }

    func testRejectsMissingRequiredField() throws {
        var object = try Fixture.object("due-task")
        object.removeValue(forKey: "until")
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object)))
    }

    func testRejectsUnknownCardKind() throws {
        var object = try Fixture.object("empty-day")
        object["entries"] = [["at": 1_795_098_600_000, "cards": [["kind": "event"], ["kind": "clear", "allDone": false, "next": NSNull()]]]]
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object))) { error in
            XCTAssertEqual(error as? TimelineError, .unknownCardKind("event"))
        }
    }

    func testRejectsCardsWithoutTrailingClear() throws {
        var object = try Fixture.object("due-task")
        var entries = try XCTUnwrap(object["entries"] as? [[String: Any]])
        var cards = try XCTUnwrap(entries[0]["cards"] as? [[String: Any]])
        cards.removeLast()
        entries[0]["cards"] = cards
        object["entries"] = entries
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object)))
    }

    func testRejectsTwoClearCards() throws {
        var object = try Fixture.object("empty-day")
        let clear: [String: Any] = ["kind": "clear", "allDone": false, "next": NSNull()]
        object["entries"] = [["at": 1_795_098_600_000, "cards": [clear, clear]]]
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object)))
    }

    func testRejectsEntriesOutOfOrder() throws {
        var object = try Fixture.object("due-task")
        let entries = try XCTUnwrap(object["entries"] as? [[String: Any]])
        var second = entries[1]
        second["at"] = 1_795_098_600_000
        object["entries"] = [entries[0], second]
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object)))
    }

    func testRejectsFirstEntryAwayFromGeneratedAt() throws {
        var object = try Fixture.object("empty-day")
        object["generatedAt"] = 1_795_098_000_000
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object)))
    }

    func testRejectsEntryAtOrAfterUntil() throws {
        var object = try Fixture.object("due-task")
        object["until"] = 1_795_105_800_000
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object)))
    }

    func testRejectsUnknownTimeZone() throws {
        var object = try Fixture.object("empty-day")
        object["timezone"] = "Mars/Olympus"
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object)))
    }

    func testRejectsStepOutsideStepCount() throws {
        try assertTaskRejected { $0["step"] = 1 }
        try assertTaskRejected { $0["step"] = -1 }
        try assertTaskRejected { $0["stepCount"] = 0 }
    }

    func testRejectsBlankLabelAndInstance() throws {
        try assertTaskRejected { $0["label"] = "  " }
        try assertTaskRejected { $0["instanceId"] = "" }
        try assertTaskRejected { $0["label"] = NSNull() }
    }

    func testTreatsBlankOptionalTextAsAbsent() throws {
        var object = try Fixture.object("due-task")
        var entries = try XCTUnwrap(object["entries"] as? [[String: Any]])
        var cards = try XCTUnwrap(entries[0]["cards"] as? [[String: Any]])
        cards[0]["sentence"] = ""
        cards[0].removeValue(forKey: "detail")
        entries[0]["cards"] = cards
        object["entries"] = entries
        let timeline = try DeviceTimeline.decode(Fixture.json(object))
        guard case .task(let task) = timeline.slices[0].cards[0] else { return XCTFail("expected a task card") }
        XCTAssertNil(task.sentence)
        XCTAssertNil(task.detail)
    }

    private func assertTaskRejected(_ change: (inout [String: Any]) -> Void, line: UInt = #line) throws {
        var object = try Fixture.object("due-task")
        var entries = try XCTUnwrap(object["entries"] as? [[String: Any]])
        var cards = try XCTUnwrap(entries[0]["cards"] as? [[String: Any]])
        change(&cards[0])
        entries[0]["cards"] = cards
        object["entries"] = entries
        XCTAssertThrowsError(try DeviceTimeline.decode(Fixture.json(object)), line: line)
    }
}
