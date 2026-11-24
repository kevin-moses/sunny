import Foundation
import XCTest

@testable import SunnyWidgetCore

final class ClockFormatTests: XCTestCase {
    func testWritesTwelveHourTimeInTheHouseholdZone() {
        let text = ClockFormat.time(Fixture.generatedAt, in: Fixture.newYork, locale: Fixture.unitedStates)
        XCTAssertEqual(normalizedSpaces(text), "9:30 AM")
    }

    func testUsesTheNamedZoneRatherThanThePhones() throws {
        let losAngeles = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let text = ClockFormat.time(Fixture.generatedAt, in: losAngeles, locale: Fixture.unitedStates)
        XCTAssertEqual(normalizedSpaces(text), "6:30 AM")
    }

    func testFollowsATwentyFourHourLocale() {
        let afternoon = Fixture.generatedAt.addingTimeInterval(minutes(5 * 60))
        XCTAssertEqual(ClockFormat.time(afternoon, in: Fixture.newYork, locale: Locale(identifier: "en_GB")), "14:30")
    }

    func testFollowsATwentyFourHourPreferenceOnAnAmericanLocale() {
        let afternoon = Fixture.generatedAt.addingTimeInterval(minutes(5 * 60))
        let text = ClockFormat.time(afternoon, in: Fixture.newYork, locale: Locale(identifier: "en_US@hours=h23"))
        XCTAssertEqual(text, "14:30")
    }
}

final class WidgetContentTests: XCTestCase {
    private func content(_ fixture: String, pressed: Set<PressKey> = []) throws -> WidgetContent {
        let timeline = try Fixture.timeline(fixture)
        let pick = try XCTUnwrap(timeline.pick(at: Fixture.generatedAt, pressed: pressed))
        return WidgetContent.from(pick, timeZone: timeline.timeZone, locale: Fixture.unitedStates)
    }

    func testDueTaskUsesTheSentence() throws {
        guard case .due(let due) = try content("due-task") else { return XCTFail("expected due content") }
        XCTAssertEqual(normalizedSpaces(due.time), "9:30 AM")
        XCTAssertEqual(due.label, "Morning pills")
        XCTAssertEqual(due.line, "Take your morning pills.")
        XCTAssertEqual(due.detail, "the small white ones")
        XCTAssertEqual(normalizedSpaces(due.spokenSummary), "Now, 9:30 AM, Take your morning pills.")
        XCTAssertEqual(due.doneAccessibilityLabel, "Done, Morning pills")
        XCTAssertEqual(due.inlineText, "Morning pills now")
    }

    func testMultiStepTaskUsesTheStepText() throws {
        guard case .due(let due) = try content("three-step-task") else { return XCTFail("expected due content") }
        XCTAssertEqual(due.line, "Fill the kettle.")
        XCTAssertEqual(due.step, 0)
    }

    func testMultiStepTaskWithoutStepTextFallsBackToTheLabel() throws {
        let pressed: Set = [PressKey(instanceId: "inst-tea", step: 0), PressKey(instanceId: "inst-tea", step: 1)]
        guard case .due(let due) = try content("three-step-task", pressed: pressed) else {
            return XCTFail("expected due content")
        }
        XCTAssertNil(due.line)
        XCTAssertEqual(due.step, 2)
        XCTAssertEqual(normalizedSpaces(due.spokenSummary), "Now, 9:30 AM, Make tea")
    }

    func testNothingDueNamesTheNextItem() throws {
        guard case .clear(let clear) = try content("nothing-due-next") else { return XCTFail("expected clear content") }
        XCTAssertEqual(clear.headline, "Nothing to do right now.")
        let next = try XCTUnwrap(clear.next)
        XCTAssertEqual(normalizedSpaces(next.panelText), "Next: Lunch at 12:30 PM")
        XCTAssertEqual(next.leadText, "Next: Lunch")
        XCTAssertEqual(normalizedSpaces(next.atTimeText), "at 12:30 PM")
        XCTAssertEqual(normalizedSpaces(next.shortText), "Next: Lunch 12:30 PM")
        XCTAssertEqual(normalizedSpaces(next.shortestText), "Next: 12:30 PM")
    }

    func testAllDoneUsesTheDisplaysWording() throws {
        guard case .clear(let clear) = try content("all-done") else { return XCTFail("expected clear content") }
        XCTAssertEqual(clear.headline, "Everything is done.")
        XCTAssertEqual(clear.next?.label, "Morning pills")
    }

    func testEmptyDayHasNoNextItem() throws {
        XCTAssertEqual(try content("empty-day"), .clear(ClearContent(headline: "Nothing to do right now.", next: nil)))
    }
}
