import Foundation
import XCTest

@testable import SunnyWidgetCore

final class PressQueueTests: XCTestCase {
    private let start = Fixture.generatedAt

    private func press(_ instance: String, step: Int = 0, at offset: TimeInterval = 0) -> Press {
        Press(instanceId: instance, step: step, via: .widget, pressedAt: start.addingTimeInterval(offset))
    }

    func testAppendsOneFilePerPressAndListsThemInPressOrder() throws {
        let directory = try temporaryDirectory()
        let queue = PressQueue(directory: directory)
        let later = press("b", at: 10)
        let earlier = press("a", at: 5)
        try queue.append(later)
        try queue.append(earlier)
        XCTAssertEqual(queue.pending(), [earlier, later])
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("presses").path)
        XCTAssertEqual(Set(files), [earlier.id.uuidString + ".json", later.id.uuidString + ".json"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent("staging").path), [])
    }

    func testRemovingAPressDeletesOnlyItsFile() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let first = press("a")
        let second = press("b", at: 1)
        try queue.append(first)
        try queue.append(second)
        queue.remove(first.id)
        XCTAssertEqual(queue.pending(), [second])
    }

    func testRecordsThePressedMarkAndKeepsItAfterSending() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let sent = press("a")
        try queue.append(sent)
        queue.remove(sent.id)
        XCTAssertEqual(queue.pressed(), [sent.key])
    }

    func testReconcileDropsMarksOfSentPressesMadeBeforeTheFetch() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        let sent = press("sent")
        let waiting = press("waiting", at: 1)
        let duringFetch = press("during", at: 30)
        for item in [sent, waiting, duringFetch] { try queue.append(item) }
        queue.remove(sent.id)
        queue.remove(duringFetch.id)
        queue.reconcile(withTimelineFetchedFrom: start.addingTimeInterval(20))
        XCTAssertEqual(queue.pressed(), [waiting.key, duringFetch.key])
    }

    func testDropsUnreadableFiles() throws {
        let directory = try temporaryDirectory()
        let queue = PressQueue(directory: directory)
        try queue.append(press("a"))
        let junk = directory.appendingPathComponent("presses/\(UUID().uuidString).json")
        try Data("{".utf8).write(to: junk)
        XCTAssertEqual(queue.pending().map(\.instanceId), ["a"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: junk.path))
    }

    func testRemoveAllClearsPressesAndMarks() throws {
        let queue = PressQueue(directory: try temporaryDirectory())
        try queue.append(press("a"))
        XCTAssertTrue(try queue.removeAll())
        XCTAssertEqual(queue.pending(), [])
        XCTAssertEqual(queue.pressed(), [])
        XCTAssertFalse(try queue.removeAll())
    }

    func testTwoInterleavedWritersKeepEveryPress() throws {
        let directory = try temporaryDirectory()
        let writers = [PressQueue(directory: directory), PressQueue(directory: directory)]
        let perWriter = 200
        DispatchQueue.concurrentPerform(iterations: perWriter * 2) { index in
            let writer = writers[index % 2]
            try? writer.append(press("writer\(index % 2)-\(index)", at: TimeInterval(index)))
        }
        let pending = PressQueue(directory: directory).pending()
        XCTAssertEqual(pending.count, perWriter * 2)
        XCTAssertEqual(Set(pending.map(\.id)).count, perWriter * 2)
        XCTAssertEqual(pending.map(\.pressedAt), pending.map(\.pressedAt).sorted())
    }
}

final class PressReplayTests: XCTestCase {
    func testDropsEveryAnsweredPress() {
        for status in [ConfirmStatus.confirmed, .advanced, .rejected(reason: "This task is not due yet"), .unrecognized("new")] {
            XCTAssertEqual(PressReplay.decision(for: .answered(status)), .drop)
        }
    }

    func testDropsAPressTheServerCouldNotRead() {
        XCTAssertEqual(PressReplay.decision(for: .unreadable), .drop)
    }

    func testKeepsThePressWhenTheServerIsNotReached() {
        XCTAssertEqual(PressReplay.decision(for: .failed), .keepAndStop)
        XCTAssertEqual(PressReplay.decision(for: .rateLimited(retryAfter: 30)), .keepAndStop)
    }

    func testKeepsThePressAndStopsOnUnauthorized() {
        XCTAssertEqual(PressReplay.decision(for: .unauthorized), .keepAndStopUnauthorized)
    }
}

final class DeviceClientTests: XCTestCase {
    private let site = URL(string: "https://example.convex.site")!

    private func response(_ status: Int, headers: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(url: site, statusCode: status, httpVersion: nil, headerFields: headers)!
    }

    func testConfirmBodyHasExactlyTheContractFields() throws {
        let client = DeviceClient(siteURL: site, token: "tok", transport: FakeTransport())
        let press = Press(instanceId: "inst", step: 2, via: .widget, pressedAt: Fixture.generatedAt)
        let request = client.confirmRequest(press, at: Fixture.generatedAt.addingTimeInterval(1.5), timeout: 4)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["instanceId", "pressedAgoMs", "via", "step"])
        XCTAssertEqual(body["instanceId"] as? String, "inst")
        XCTAssertEqual(body["pressedAgoMs"] as? Int, 1500)
        XCTAssertEqual(body["via"] as? String, "widget")
        XCTAssertEqual(body["step"] as? Int, 2)
        XCTAssertEqual(request.url?.absoluteString, "https://example.convex.site/device/confirm")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
    }

    func testPressAgeIsNeverNegative() {
        let press = Press(instanceId: "inst", step: 0, via: .widget, pressedAt: Fixture.generatedAt)
        XCTAssertEqual(press.pressedAgoMs(at: Fixture.generatedAt.addingTimeInterval(-60)), 0)
    }

    func testTimelineRequestSendsTheEtag() {
        let client = DeviceClient(siteURL: site, token: "tok", transport: FakeTransport())
        let request = client.timelineRequest(etag: "\"abc\"", timeout: 10)
        XCTAssertEqual(request.url?.absoluteString, "https://example.convex.site/device/timeline")
        XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "\"abc\"")
        XCTAssertNil(client.timelineRequest(etag: nil, timeout: 10).value(forHTTPHeaderField: "If-None-Match"))
    }

    func testClassifiesTimelineResponses() {
        let body = Data("{}".utf8)
        XCTAssertEqual(
            DeviceClient.fetchOutcome(status: 200, body: body, headers: response(200, headers: ["ETag": "\"v\""])),
            .fresh(body: body, etag: "\"v\"")
        )
        XCTAssertEqual(DeviceClient.fetchOutcome(status: 304, body: Data(), headers: response(304)), .notModified)
        XCTAssertEqual(DeviceClient.fetchOutcome(status: 401, body: Data(), headers: response(401)), .unauthorized)
        XCTAssertEqual(
            DeviceClient.fetchOutcome(status: 429, body: Data(), headers: response(429, headers: ["Retry-After": "12"])),
            .rateLimited(retryAfter: 12)
        )
        XCTAssertEqual(DeviceClient.fetchOutcome(status: 500, body: Data(), headers: response(500)), .failed)
    }

    func testClassifiesConfirmResponses() throws {
        let rejected = try Fixture.json(["status": "rejected", "reason": "This task is not due yet", "state": NSNull()])
        XCTAssertEqual(
            DeviceClient.confirmOutcome(status: 200, body: rejected, headers: response(200)),
            .answered(.rejected(reason: "This task is not due yet"))
        )
        let confirmed = try Fixture.json(["status": "confirmed", "reason": NSNull(), "state": [:]])
        XCTAssertEqual(DeviceClient.confirmOutcome(status: 200, body: confirmed, headers: response(200)), .answered(.confirmed))
        let advanced = try Fixture.json(["status": "advanced", "reason": NSNull(), "state": NSNull()])
        XCTAssertEqual(DeviceClient.confirmOutcome(status: 200, body: advanced, headers: response(200)), .answered(.advanced))
        XCTAssertEqual(DeviceClient.confirmOutcome(status: 400, body: Data(), headers: response(400)), .unreadable)
        XCTAssertEqual(DeviceClient.confirmOutcome(status: 401, body: Data(), headers: response(401)), .unauthorized)
        XCTAssertEqual(DeviceClient.confirmOutcome(status: 503, body: Data(), headers: response(503)), .failed)
    }
}
