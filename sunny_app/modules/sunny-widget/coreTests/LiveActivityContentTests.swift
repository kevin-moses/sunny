import Foundation
import XCTest

@testable import SunnyWidgetCore

enum PushFixture {
    static let directory = "Fixtures/liveActivity"

    static func all() throws -> [(name: String, aps: [String: Any])] {
        let urls = try XCTUnwrap(Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: directory))
        return try urls.sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { url in
            let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
            return aps(in: object).map { (url.lastPathComponent, $0) }
        }
    }

    static func aps(in object: Any) -> [String: Any]? {
        guard let root = object as? [String: Any] else { return nil }
        return (root["aps"] as? [String: Any]) ?? root["payload"].flatMap(aps(in:))
    }

    static func aps(named name: String) throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: directory))
        return try XCTUnwrap(aps(in: JSONSerialization.jsonObject(with: Data(contentsOf: url))))
    }

    static func section<T: Decodable>(_ type: T.Type, _ key: String, in aps: [String: Any]) throws -> T? {
        guard let value = aps[key] else { return nil }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: value))
    }
}

enum Sample {
    static let startsAt = Fixture.generatedAt
    static let endsAt = Fixture.generatedAt.addingTimeInterval(minutes(60))

    static func card(
        instanceId: String = "inst-tea",
        step: Int = 0,
        stepCount: Int = 1,
        stepText: String? = nil,
        label: String = "Morning pills",
        sentence: String? = "Take your morning pills.",
        detail: String? = "the small white ones",
        icon: TaskIcon? = .pills
    ) -> TaskCard {
        TaskCard(
            instanceId: instanceId,
            step: step,
            stepCount: stepCount,
            stepText: stepText,
            label: label,
            sentence: sentence,
            detail: detail,
            startsAt: startsAt,
            endsAt: endsAt,
            icon: icon
        )
    }

    static func state(_ card: TaskCard = card(), nextSteps: [String] = [], closed: ActivityClosed? = nil) -> TaskActivityState {
        TaskActivityState(card: card, nextSteps: nextSteps, closed: closed)
    }

    static let tea = state(
        card(stepCount: 3, stepText: "Fill the kettle.", label: "Make tea", sentence: nil, detail: nil, icon: .checklist),
        nextSteps: ["Put a tea bag in the cup.", "Pour the water."]
    )
}

final class LiveActivityContentTests: XCTestCase {
    func testEveryPushFixtureDecodesWithAPlainDecoder() throws {
        var events: [String: Int] = [:]
        for fixture in try PushFixture.all() {
            guard let event = fixture.aps["event"] as? String else { continue }
            events[event, default: 0] += 1
            let state = try PushFixture.section(TaskActivityState.self, "content-state", in: fixture.aps)
            XCTAssertNotNil(state, "\(fixture.name) has no content-state")
            if event == "start" {
                XCTAssertEqual(fixture.aps["attributes-type"] as? String, String(describing: SunnyTaskAttributes.self))
                let attributes = try XCTUnwrap(
                    try PushFixture.section(SunnyTaskAttributes.self, "attributes", in: fixture.aps),
                    fixture.name
                )
                XCTAssertEqual(attributes.instanceId, state?.card.instanceId, fixture.name)
                XCTAssertEqual(attributes.receiptDuration, 10, fixture.name)
                XCTAssertEqual(attributes.householdTimeZone.identifier, "America/New_York", fixture.name)
                XCTAssertNil(state?.closed, fixture.name)
            }
            if event == "end" {
                XCTAssertNotNil(state?.closed, "\(fixture.name) ends without saying why")
            }
        }
        XCTAssertGreaterThan(events["start"] ?? 0, 0)
        XCTAssertGreaterThan(events["update"] ?? 0, 0)
        XCTAssertGreaterThan(events["end"] ?? 0, 0)
    }

    func testTheLockScreenTellsTimeInTheZoneTheStartCarries() throws {
        let attributes = SunnyTaskAttributes(activityKey: "k", instanceId: "i", receiptMs: 10_000, timeZone: "Asia/Tokyo")
        let pressed = Sample.state(Sample.card(), closed: ActivityClosed(kind: .done, at: Fixture.generatedAt))
        let face = TaskActivityFace(
            state: pressed,
            isStale: false,
            timeZone: attributes.householdTimeZone,
            locale: Fixture.unitedStates
        )
        guard case .receipt(_, let noted) = face else { return XCTFail("expected the receipt") }
        XCTAssertEqual(normalizedSpaces(noted), "Noted at 11:30 PM")
    }

    func testContentStateReadsEpochMillisecondsAndTheIcon() throws {
        let json = """
            {"card":{"kind":"task","instanceId":"inst-tea","step":1,"stepCount":3,"stepText":"Pour.",
            "label":"Make tea","sentence":null,"detail":"  ","startsAt":1795098600000,"endsAt":1795102200000,
            "icon":"checklist"},"nextSteps":["Drink."],"closed":{"kind":"done","at":1795099800000}}
            """
        let state = try JSONDecoder().decode(TaskActivityState.self, from: Data(json.utf8))
        XCTAssertEqual(state.card.startsAt, Fixture.generatedAt)
        XCTAssertEqual(state.card.endsAt, Fixture.generatedAt.addingTimeInterval(minutes(60)))
        XCTAssertEqual(state.card.icon, .checklist)
        XCTAssertNil(state.card.detail)
        XCTAssertEqual(state.nextSteps, ["Drink."])
        XCTAssertEqual(state.closed, ActivityClosed(kind: .done, at: Fixture.generatedAt.addingTimeInterval(minutes(20))))
    }

    func testContentStateRoundTripsThroughTheDefaultCoders() throws {
        let state = Sample.state(closed: ActivityClosed(kind: .over, at: Sample.endsAt))
        let data = try JSONEncoder().encode(state)
        XCTAssertEqual(try JSONDecoder().decode(TaskActivityState.self, from: data), state)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let card = try XCTUnwrap(object["card"] as? [String: Any])
        XCTAssertEqual(card["startsAt"] as? Double, 1_795_098_600_000)
        XCTAssertEqual(card["icon"] as? String, "pills")
        XCTAssertTrue(card["stepText"] is NSNull)
        XCTAssertEqual((object["closed"] as? [String: Any])?["at"] as? Double, 1_795_102_200_000)
    }

    func testOpenContentEncodesClosedAsNull() throws {
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(Sample.state())) as? [String: Any]
        )
        XCTAssertTrue(object["closed"] is NSNull)
    }

    func testContentStateRefusesAStepOutsideItsSteps() {
        let json = """
            {"card":{"instanceId":"i","step":3,"stepCount":3,"label":"Tea","startsAt":0,"endsAt":1},
            "nextSteps":[],"closed":null}
            """
        XCTAssertThrowsError(try JSONDecoder().decode(TaskActivityState.self, from: Data(json.utf8)))
    }

    func testTimelineCardsCarryTheIconAndTolerateUnknownOrMissingOnes() throws {
        var object = try Fixture.object("due-task")
        var entries = try XCTUnwrap(object["entries"] as? [[String: Any]])
        var cards = try XCTUnwrap(entries[0]["cards"] as? [[String: Any]])
        cards[0]["icon"] = "bell"
        entries[0]["cards"] = cards
        object["entries"] = entries
        guard case .task(let withBell) = try DeviceTimeline.decode(Fixture.json(object)).slices[0].cards[0] else {
            return XCTFail("expected a task card")
        }
        XCTAssertEqual(withBell.icon, .bell)

        cards[0]["icon"] = "rocket"
        entries[0]["cards"] = cards
        object["entries"] = entries
        guard case .task(let unknown) = try DeviceTimeline.decode(Fixture.json(object)).slices[0].cards[0] else {
            return XCTFail("expected a task card")
        }
        XCTAssertNil(unknown.icon)

        guard case .task(let missing) = try Fixture.timeline("due-task").slices[0].cards[0] else {
            return XCTFail("expected a task card")
        }
        XCTAssertNil(missing.icon)
    }

    func testEachIconHasItsSymbolAndATaskWithoutOneGetsTheClock() {
        XCTAssertEqual(TaskIcon.symbolName(.pills), "pill")
        XCTAssertEqual(TaskIcon.symbolName(.calendar), "calendar")
        XCTAssertEqual(TaskIcon.symbolName(.checklist), "checklist")
        XCTAssertEqual(TaskIcon.symbolName(.bell), "bell")
        XCTAssertEqual(TaskIcon.symbolName(.clock), "clock")
        XCTAssertEqual(TaskIcon.symbolName(nil), "clock")
    }
}

final class TaskActivityFaceTests: XCTestCase {
    private func face(_ state: TaskActivityState, stale: Bool = false) -> TaskActivityFace {
        TaskActivityFace(state: state, isStale: stale, timeZone: Fixture.newYork, locale: Fixture.unitedStates)
    }

    func testAnOpenTaskIsDueWithItsTimeLineAndDetail() {
        guard case .due(let due) = face(Sample.state()) else { return XCTFail("expected due") }
        XCTAssertEqual(normalizedSpaces(due.time), "9:30 AM")
        XCTAssertEqual(due.label, "Morning pills")
        XCTAssertEqual(due.line, "Take your morning pills.")
        XCTAssertEqual(due.detail, "the small white ones")
        XCTAssertEqual(due.icon, .pills)
        XCTAssertEqual(due.instanceId, "inst-tea")
        XCTAssertEqual(due.step, 0)
    }

    func testAStepTaskShowsTheStepText() {
        guard case .due(let due) = face(Sample.tea) else { return XCTFail("expected due") }
        XCTAssertEqual(due.line, "Fill the kettle.")
        XCTAssertEqual(due.secondLine, "Fill the kettle.")
    }

    func testATaskWithoutStepsHasItsDetailUnderTheLabel() {
        guard case .due(let due) = face(Sample.state()) else { return XCTFail("expected due") }
        XCTAssertNil(due.stepLine)
        XCTAssertEqual(due.secondLine, "the small white ones")
    }

    func testDoneShowsTheReceiptWithThePressTime() {
        let state = Sample.state(closed: ActivityClosed(kind: .done, at: Fixture.generatedAt.addingTimeInterval(minutes(11))))
        guard case .receipt(let due, let noted) = face(state) else { return XCTFail("expected the receipt") }
        XCTAssertEqual(normalizedSpaces(noted), "Noted at 9:41 AM")
        XCTAssertEqual(due.label, "Morning pills")
    }

    func testAStaleOpenTaskIsOver() {
        guard case .over(let due) = face(Sample.state(), stale: true) else { return XCTFail("expected over") }
        XCTAssertEqual(due.label, "Morning pills")
    }

    func testAClosedOverTaskIsOverEvenBeforeItIsStale() {
        guard case .over = face(Sample.state(closed: ActivityClosed(kind: .over, at: Sample.endsAt))) else {
            return XCTFail("expected over")
        }
    }

    func testTheReceiptWinsOverStaleness() {
        let state = Sample.state(closed: ActivityClosed(kind: .done, at: Fixture.generatedAt))
        guard case .receipt = face(state, stale: true) else { return XCTFail("expected the receipt") }
    }
}

final class PressEffectTests: XCTestCase {
    private let now = Fixture.generatedAt.addingTimeInterval(minutes(11))

    func testThePressOnTheOnlyStepFinishesWithTheReceipt() {
        let effect = PressEffect.after(Sample.state(), pressedStep: 0, at: now)
        XCTAssertEqual(
            effect,
            .finish(Sample.state(closed: ActivityClosed(kind: .done, at: now)))
        )
    }

    func testThePressOnAnEarlierStepShowsTheNextStep() {
        guard case .advance(let next) = PressEffect.after(Sample.tea, pressedStep: 0, at: now) else {
            return XCTFail("expected the next step")
        }
        XCTAssertEqual(next.card.step, 1)
        XCTAssertEqual(next.card.stepCount, 3)
        XCTAssertEqual(next.card.stepText, "Put a tea bag in the cup.")
        XCTAssertEqual(next.card.label, "Make tea")
        XCTAssertEqual(next.nextSteps, ["Pour the water."])
        XCTAssertNil(next.closed)
    }

    func testWalkingEveryStepEndsInTheReceipt() {
        var state = Sample.tea
        var texts: [String?] = []
        for step in 0..<3 {
            switch PressEffect.after(state, pressedStep: step, at: now) {
            case .advance(let next):
                texts.append(next.card.stepText)
                state = next
            case .finish(let receipt):
                XCTAssertEqual(step, 2)
                XCTAssertEqual(receipt.closed, ActivityClosed(kind: .done, at: now))
                XCTAssertEqual(texts, ["Put a tea bag in the cup.", "Pour the water."])
                return
            case nil:
                return XCTFail("a press on the shown step was ignored")
            }
        }
        XCTFail("the last step did not finish")
    }

    func testAShortLookaheadLeavesTheNextStepWithoutText() {
        let state = Sample.state(Sample.tea.card, nextSteps: [])
        guard case .advance(let next) = PressEffect.after(state, pressedStep: 0, at: now) else {
            return XCTFail("expected the next step")
        }
        XCTAssertEqual(next.card.step, 1)
        XCTAssertNil(next.card.stepText)
    }

    func testAPressOnAStepThatIsNoLongerShownChangesNothing() {
        XCTAssertNil(PressEffect.after(Sample.tea, pressedStep: 1, at: now))
    }

    func testAPressOnAClosedActivityChangesNothing() {
        let closed = Sample.state(closed: ActivityClosed(kind: .done, at: Fixture.generatedAt))
        XCTAssertNil(PressEffect.after(closed, pressedStep: 0, at: now))
    }
}
