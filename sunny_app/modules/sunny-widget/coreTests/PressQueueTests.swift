import Foundation
import XCTest

@testable import SunnyWidgetCore

final class PressQueueTests: XCTestCase {
    private let start = Fixture.generatedAt

    private func press(_ instance: String, step: Int = 0, at offset: TimeInterval = 0) -> Press {
        Press(instanceId: instance, step: step, via: .widget, pressedAt: start.addingTimeInterval(offset))
    }

    private func undo(_ press: Press, at offset: TimeInterval) -> PressUndo {
        PressUndo(pressId: press.id, instanceId: press.instanceId, undoneAt: start.addingTimeInterval(offset))
    }

    private func answer(at offset: TimeInterval, applied: Bool = true, count: Int? = nil) -> PressAnswer {
        PressAnswer(at: start.addingTimeInterval(offset), applied: applied, answeredPresses: count)
    }

    private func logFiles(_ directory: URL) throws -> Set<String> {
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("pressLog").path)
        return Set(names).subtracting(["staging"])
    }

    func testKeepsOneFilePerPressAndSendsThemInPressOrder() throws {
        let directory = try temporaryDirectory()
        let queue = PressQueue(directory: directory)
        let later = press("b", at: 10)
        let earlier = press("a", at: 5)
        try queue.append(later)
        try queue.append(earlier)
        XCTAssertEqual(queue.unsent(), [.confirm(earlier), .confirm(later)])
        XCTAssertEqual(try logFiles(directory), [earlier.id.uuidString + ".press.json", later.id.uuidString + ".press.json"])
        let staging = directory.appendingPathComponent("pressLog/staging")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: staging.path), [])
    }

    func testAnAnsweredPressIsNotSentAgainAndStaysInTheLogWithItsAnswer() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let first = press("a")
        let second = press("b", at: 1)
        try queue.append(first)
        try queue.append(second)
        queue.answered(.confirm(first), with: answer(at: 2, count: 7))
        XCTAssertEqual(queue.unsent(), [.confirm(second)])
        XCTAssertEqual(
            queue.records(),
            [PressRecord(press: first, answer: answer(at: 2, count: 7)), PressRecord(press: second)]
        )
    }

    func testAPressHidesItsCardUntilATimelineFetchedAfterItsAnswer() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let answeredBefore = press("answered-before")
        let answeredAfter = press("answered-after")
        let waiting = press("waiting", at: 1)
        let duringFetch = press("during", at: 30)
        for item in [answeredBefore, answeredAfter, waiting, duringFetch] { try queue.append(item) }
        queue.answered(.confirm(answeredBefore), with: answer(at: 10))
        queue.answered(.confirm(answeredAfter), with: answer(at: 25))
        queue.answered(.confirm(duringFetch), with: answer(at: 31))
        XCTAssertEqual(
            queue.hidden(onTimelineFetchedFrom: start.addingTimeInterval(20)),
            [answeredAfter.key, waiting.key, duringFetch.key]
        )
        XCTAssertEqual(queue.hidden(onTimelineFetchedFrom: nil).count, 4)
        XCTAssertEqual(queue.hidden(onTimelineFetchedFrom: start.addingTimeInterval(40)), [waiting.key])
    }

    func testAnUndonePressShowsItsCardAgainAndItsUndoIsSentAfterIt() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let pressed = press("a")
        let other = press("b", at: 5)
        try queue.append(pressed)
        try queue.append(other)
        try queue.append(undo(pressed, at: 10))
        XCTAssertEqual(queue.hidden(onTimelineFetchedFrom: nil), [other.key])
        XCTAssertEqual(queue.unsent(), [.confirm(pressed), .confirm(other), .undo(undo(pressed, at: 10))])
        queue.answered(.confirm(pressed), with: answer(at: 11))
        XCTAssertEqual(queue.unsent(), [.confirm(other), .undo(undo(pressed, at: 10))])
        queue.answered(.undo(undo(pressed, at: 10)), with: answer(at: 12))
        XCTAssertEqual(queue.unsent(), [.confirm(other)])
        XCTAssertEqual(queue.record(pressed.id)?.undoAnswer, answer(at: 12))
    }

    func testAnUndoNeverGoesBeforeItsPressWhenTheClockWentBack() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let pressed = press("a", at: 100)
        try queue.append(pressed)
        try queue.append(undo(pressed, at: 40))
        XCTAssertEqual(queue.unsent(), [.confirm(pressed), .undo(undo(pressed, at: 40))])
    }

    func testASecondUndoOfOnePressKeepsTheFirst() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let pressed = press("a")
        try queue.append(pressed)
        try queue.append(undo(pressed, at: 10))
        try queue.append(undo(pressed, at: 20))
        XCTAssertEqual(queue.record(pressed.id)?.undo, undo(pressed, at: 10))
    }

    func testTwoAnswersToOneSendKeepTheFirstTimeTheAppliedVerdictAndTheHighestCount() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let pressed = press("a")
        try queue.append(pressed)
        try queue.append(undo(pressed, at: 5))
        queue.answered(.confirm(pressed), with: answer(at: 6, applied: true, count: 3))
        queue.answered(.confirm(pressed), with: answer(at: 9, applied: false, count: 5))
        queue.answered(.undo(undo(pressed, at: 5)), with: answer(at: 10, applied: false, count: nil))
        queue.answered(.undo(undo(pressed, at: 5)), with: answer(at: 8, applied: true, count: 4))
        XCTAssertEqual(queue.record(pressed.id)?.answer, answer(at: 6, applied: true, count: 5))
        XCTAssertEqual(queue.record(pressed.id)?.undoAnswer, answer(at: 8, applied: true, count: 4))
    }

    func testCollectsOnlyFinishedRecordsOlderThanTwoDays() throws {
        let directory = try temporaryDirectory()
        let queue = PressQueue(directory: directory)
        let oldAnswered = press("old-answered")
        let oldUndone = press("old-undone", at: 1)
        let oldUnsent = press("old-unsent", at: 2)
        let oldUndoUnsent = press("old-undo-unsent", at: 3)
        let recent = press("recent", at: PressQueue.recordLifetime)
        for item in [oldAnswered, oldUndone, oldUnsent, oldUndoUnsent, recent] { try queue.append(item) }
        for item in [oldAnswered, oldUndone, oldUndoUnsent, recent] { queue.answered(.confirm(item), with: answer(at: 4)) }
        try queue.append(undo(oldUndone, at: 5))
        queue.answered(.undo(undo(oldUndone, at: 5)), with: answer(at: 6))
        try queue.append(undo(oldUndoUnsent, at: 5))
        queue.collect(at: start.addingTimeInterval(PressQueue.recordLifetime + 60))
        XCTAssertEqual(queue.records().map(\.press.instanceId), ["old-unsent", "old-undo-unsent", "recent"])
        XCTAssertEqual(try logFiles(directory).count, 6)
    }

    func testCollectRemovesFilesWhosePressIsGone() throws {
        let directory = try temporaryDirectory()
        let queue = PressQueue(directory: directory)
        let pressed = press("a")
        try queue.append(pressed)
        queue.answered(.confirm(pressed), with: answer(at: 1))
        try queue.append(undo(pressed, at: 2))
        let log = directory.appendingPathComponent("pressLog")
        try FileManager.default.removeItem(at: log.appendingPathComponent(pressed.id.uuidString + ".press.json"))
        XCTAssertEqual(queue.records(), [])
        XCTAssertEqual(queue.unsent(), [])
        queue.collect(at: start)
        XCTAssertEqual(try logFiles(directory), [])
    }

    func testDropsAPressFileItCannotDecode() throws {
        let directory = try temporaryDirectory()
        let queue = PressQueue(directory: directory)
        try queue.append(press("a"))
        let junk = directory.appendingPathComponent("pressLog/\(UUID().uuidString).press.json")
        try Data("{".utf8).write(to: junk)
        XCTAssertEqual(queue.unsentPresses.map(\.instanceId), ["a"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: junk.path))
    }

    func testRemoveAllClearsTheLog() throws {
        let directory = try temporaryDirectory()
        let queue = PressQueue(directory: directory)
        let pressed = press("a")
        try queue.append(pressed)
        try queue.append(undo(pressed, at: 1))
        try queue.removeAll()
        XCTAssertEqual(queue.records(), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
        try queue.removeAll()
    }

    func testAnUndoWrittenWhileItsPressIsAnsweredLosesNeither() throws {
        let directory = try temporaryDirectory()
        let answering = PressQueue(directory: directory)
        let undoing = PressQueue(directory: directory)
        for round in 0..<200 {
            let pressed = press("a", at: TimeInterval(round))
            try answering.append(pressed)
            let taken = undo(pressed, at: TimeInterval(round) + 1)
            DispatchQueue.concurrentPerform(iterations: 2) { side in
                if side == 0 {
                    answering.answered(.confirm(pressed), with: answer(at: TimeInterval(round) + 1))
                } else {
                    try? undoing.append(taken)
                }
            }
            let record = PressQueue(directory: directory).record(pressed.id)
            XCTAssertEqual(record?.undo, taken, "round \(round)")
            XCTAssertNotNil(record?.answer, "round \(round)")
        }
    }

    func testTwoInterleavedWritersKeepEveryPress() throws {
        let directory = try temporaryDirectory()
        let writers = [PressQueue(directory: directory), PressQueue(directory: directory)]
        let perWriter = 200
        DispatchQueue.concurrentPerform(iterations: perWriter * 2) { index in
            let writer = writers[index % 2]
            try? writer.append(press("writer\(index % 2)-\(index)", at: TimeInterval(index)))
        }
        let pending = PressQueue(directory: directory).unsentPresses
        XCTAssertEqual(pending.count, perWriter * 2)
        XCTAssertEqual(Set(pending.map(\.id)).count, perWriter * 2)
        XCTAssertEqual(pending.map(\.pressedAt), pending.map(\.pressedAt).sorted())
    }
}

final class PressReplayTests: XCTestCase {
    func testDropsEveryAnsweredSend() {
        let statuses: [AnswerStatus] = [
            .confirmed, .advanced, .undone, .rejected(reason: "This task is not due yet"), .tooLate, .unrecognized("new"),
        ]
        for status in statuses {
            XCTAssertEqual(PressReplay.decision(for: .answered(ServerAnswer(status: status))), .drop)
        }
    }

    func testOnlyAConfirmAnAdvanceAndAnUndoCountAsApplied() {
        XCTAssertEqual([AnswerStatus.confirmed, .advanced, .undone].map(\.applied), [true, true, true])
        XCTAssertEqual(
            [AnswerStatus.rejected(reason: nil), .tooLate, .unrecognized("new")].map(\.applied),
            [false, false, false]
        )
    }

    func testDropsASendTheServerCouldNotRead() {
        XCTAssertEqual(PressReplay.decision(for: .unreadable), .drop)
    }

    func testKeepsTheSendWhenTheServerIsNotReached() {
        XCTAssertEqual(PressReplay.decision(for: .failed), .keepAndStop)
        XCTAssertEqual(PressReplay.decision(for: .rateLimited(retryAfter: 30)), .keepAndStop)
    }

    func testHoldsOnlyItsOwnTaskOnAServerError() {
        XCTAssertEqual(PressReplay.decision(for: .serverError(status: 503)), .keepAndHoldTask)
    }

    func testKeepsTheSendAndStopsOnUnauthorized() {
        XCTAssertEqual(PressReplay.decision(for: .unauthorized), .keepAndStopUnauthorized)
    }
}

final class PressLogEntryTests: XCTestCase {
    func testShapesARecordForTheAppWithOnlyWhatItHas() throws {
        let id = try XCTUnwrap(UUID(uuidString: "6F1B2C3D-0000-4000-8000-00000000000A"))
        let pressedAt = Date(timeIntervalSince1970: 1_795_098_600)
        let press = Press(id: id, instanceId: "inst", step: 1, via: .widget, pressedAt: pressedAt)
        let unsent = PressLogEntry.json(PressRecord(press: press))
        XCTAssertEqual(Set(unsent.keys), ["pressId", "instanceId", "step", "pressedAt"])
        XCTAssertEqual(unsent["pressId"] as? String, "6F1B2C3D-0000-4000-8000-00000000000A")
        XCTAssertEqual(unsent["pressedAt"] as? Double, 1_795_098_600_000)

        let undone = PressLogEntry.json(
            PressRecord(
                press: press,
                answer: PressAnswer(at: pressedAt, applied: true, answeredPresses: 4),
                undo: PressUndo(pressId: id, instanceId: "inst", undoneAt: pressedAt.addingTimeInterval(9)),
                undoAnswer: PressAnswer(at: pressedAt, applied: false, answeredPresses: nil)
            )
        )
        let answer = try XCTUnwrap(undone["answer"] as? [String: Any])
        XCTAssertEqual(answer["applied"] as? Bool, true)
        XCTAssertEqual(answer["answeredPresses"] as? Int, 4)
        let undo = try XCTUnwrap(undone["undo"] as? [String: Any])
        XCTAssertEqual(undo["undoneAt"] as? Double, 1_795_098_609_000)
        let undoAnswer = try XCTUnwrap(undo["answer"] as? [String: Any])
        XCTAssertEqual(undoAnswer["applied"] as? Bool, false)
        XCTAssertNil(undoAnswer["answeredPresses"])
    }

    func testNamesWhatHappenedToAPressAndAnUndo() {
        let press = Press(instanceId: "inst", step: 0, via: .phoneApp, pressedAt: Fixture.generatedAt)
        XCTAssertEqual(PressLogEntry.status(StoredPress.stored(press)), "stored")
        XCTAssertEqual(PressLogEntry.status(StoredPress.sentUnstored(.clean)), "sent")
        XCTAssertEqual(PressLogEntry.status(StoredPress.sentUnstored(.pending)), "notSaved")
        XCTAssertEqual(PressLogEntry.status(StoredPress.sentUnstored(.unauthorized)), "notSaved")
        XCTAssertEqual(PressLogEntry.status(StoredPress.noCredentials), "noCredentials")
        XCTAssertEqual(PressLogEntry.status(StoredUndo.stored), "stored")
        XCTAssertEqual(PressLogEntry.status(StoredUndo.notStored), "notSaved")
        XCTAssertEqual(PressLogEntry.status(StoredUndo.noCredentials), "noCredentials")
    }
}

final class DeviceClientTests: XCTestCase {
    private let site = URL(string: "https://example.convex.site")!

    private func response(_ status: Int, headers: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(url: site, statusCode: status, httpVersion: nil, headerFields: headers)!
    }

    private func body(_ request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
    }

    func testConfirmBodyHasExactlyTheContractFields() throws {
        let client = DeviceClient(siteURL: site, token: "tok", transport: FakeTransport())
        let press = Press(instanceId: "inst", step: 2, via: .phoneApp, pressedAt: Fixture.generatedAt)
        let request = client.request(for: .confirm(press), at: Fixture.generatedAt.addingTimeInterval(1.5), timeout: 4)
        let sent = try body(request)
        XCTAssertEqual(Set(sent.keys), ["instanceId", "pressedAgoMs", "via", "step", "pressId"])
        XCTAssertEqual(sent["instanceId"] as? String, "inst")
        XCTAssertEqual(sent["pressedAgoMs"] as? Int, 1500)
        XCTAssertEqual(sent["via"] as? String, "phone_app")
        XCTAssertEqual(sent["step"] as? Int, 2)
        XCTAssertEqual(sent["pressId"] as? String, press.id.uuidString)
        XCTAssertEqual(request.url?.absoluteString, "https://example.convex.site/device/confirm")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
    }

    func testUndoBodyNamesThePressAndHowLongAgoItWasTapped() throws {
        let client = DeviceClient(siteURL: site, token: "tok", transport: FakeTransport())
        let undo = PressUndo(pressId: UUID(), instanceId: "inst", undoneAt: Fixture.generatedAt)
        let request = client.request(for: .undo(undo), at: Fixture.generatedAt.addingTimeInterval(20), timeout: 4)
        let sent = try body(request)
        XCTAssertEqual(Set(sent.keys), ["instanceId", "pressId", "undoneAgoMs"])
        XCTAssertEqual(sent["instanceId"] as? String, "inst")
        XCTAssertEqual(sent["pressId"] as? String, undo.pressId.uuidString)
        XCTAssertEqual(sent["undoneAgoMs"] as? Int, 20_000)
        XCTAssertEqual(request.url?.absoluteString, "https://example.convex.site/device/undo")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
    }

    func testAPressIdIsOneTheServerAccepts() {
        let id = Press(instanceId: "inst", step: 0, via: .widget, pressedAt: Fixture.generatedAt).id.uuidString
        XCTAssertNotNil(id.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression))
    }

    func testPressAgeIsNeverNegative() {
        let press = Press(instanceId: "inst", step: 0, via: .widget, pressedAt: Fixture.generatedAt)
        XCTAssertEqual(QueuedSend.confirm(press).agoMs(at: Fixture.generatedAt.addingTimeInterval(-60)), 0)
    }

    func testTimelineRequestSendsTheCachedVersionAsTheServersQuotedETag() {
        let client = DeviceClient(siteURL: site, token: "tok", transport: FakeTransport())
        let request = client.timelineRequest(cachedVersion: "abc", timeout: 10)
        XCTAssertEqual(request.url?.absoluteString, "https://example.convex.site/device/timeline")
        XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "\"abc\"")
        XCTAssertNil(client.timelineRequest(cachedVersion: nil, timeout: 10).value(forHTTPHeaderField: "If-None-Match"))
    }

    func testClassifiesTimelineResponses() {
        let body = Data("{}".utf8)
        XCTAssertEqual(
            DeviceClient.fetchOutcome(status: 200, body: body, headers: response(200, headers: ["ETag": "\"v\""])),
            .fresh(body: body)
        )
        XCTAssertEqual(DeviceClient.fetchOutcome(status: 304, body: Data(), headers: response(304)), .notModified)
        XCTAssertEqual(DeviceClient.fetchOutcome(status: 401, body: Data(), headers: response(401)), .unauthorized)
        XCTAssertEqual(
            DeviceClient.fetchOutcome(status: 429, body: Data(), headers: response(429, headers: ["Retry-After": "12"])),
            .rateLimited(retryAfter: 12)
        )
        XCTAssertEqual(DeviceClient.fetchOutcome(status: 500, body: Data(), headers: response(500)), .failed)
    }

    func testClassifiesAnswersToAPressAndAnUndo() throws {
        func outcome(_ status: Int, _ body: Data = Data()) -> SendOutcome {
            DeviceClient.sendOutcome(status: status, body: body, headers: response(status))
        }
        XCTAssertEqual(
            outcome(200, try Answer.body("rejected", reason: "This task is not due yet", count: 3)),
            .answered(ServerAnswer(status: .rejected(reason: "This task is not due yet"), answeredPresses: 3))
        )
        XCTAssertEqual(outcome(200, try Answer.confirmed(count: 4)), .answered(ServerAnswer(status: .confirmed, answeredPresses: 4)))
        XCTAssertEqual(outcome(200, try Answer.body("advanced")), .answered(ServerAnswer(status: .advanced)))
        XCTAssertEqual(outcome(200, try Answer.undone(count: 5)), .answered(ServerAnswer(status: .undone, answeredPresses: 5)))
        XCTAssertEqual(outcome(200, try Answer.body("too_late")), .answered(ServerAnswer(status: .tooLate)))
        XCTAssertEqual(outcome(200, try Answer.body("later")), .answered(ServerAnswer(status: .unrecognized("later"))))
        XCTAssertEqual(outcome(200, Data("nope".utf8)), .answered(ServerAnswer(status: .unrecognized(""))))
        XCTAssertEqual(outcome(400), .unreadable)
        XCTAssertEqual(outcome(401), .unauthorized)
        XCTAssertEqual(outcome(503), .serverError(status: 503))
    }
}
