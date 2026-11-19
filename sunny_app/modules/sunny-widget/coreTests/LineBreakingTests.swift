import XCTest

@testable import SunnyWidgetCore

final class LineBreakingTests: XCTestCase {
    private func fitsWithin(_ characters: Int) -> (String) -> Bool {
        { $0.count <= characters }
    }

    func testKeepsShortTextOnOneLine() {
        XCTAssertEqual(LineBreaking.greedy("Lunch", maxLines: 2, fits: fitsWithin(10)), ["Lunch"])
    }

    func testBreaksAtWordsGreedily() {
        XCTAssertEqual(
            LineBreaking.greedy("Nothing to do right now.", maxLines: 4, fits: fitsWithin(10)),
            ["Nothing to", "do right", "now."]
        )
    }

    func testPutsTheRestOnTheLastAllowedLine() {
        XCTAssertEqual(
            LineBreaking.greedy("Nothing to do right now.", maxLines: 2, fits: fitsWithin(10)),
            ["Nothing to", "do right now."]
        )
    }

    func testKeepsAnOverlongWordOnItsOwnLine() {
        XCTAssertEqual(
            LineBreaking.greedy("Physiotherapy now", maxLines: 3, fits: fitsWithin(5)),
            ["Physiotherapy", "now"]
        )
    }

    func testCollapsesRepeatedSpaces() {
        XCTAssertEqual(LineBreaking.greedy("  Morning   pills ", maxLines: 2, fits: fitsWithin(20)), ["Morning pills"])
    }

    func testEmptyTextHasNoLines() {
        XCTAssertEqual(LineBreaking.greedy("   ", maxLines: 2, fits: fitsWithin(20)), [])
    }
}
