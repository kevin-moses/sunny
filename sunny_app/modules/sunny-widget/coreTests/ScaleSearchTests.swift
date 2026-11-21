import Foundation
import XCTest

@testable import SunnyWidgetCore

final class ScaleSearchTests: XCTestCase {
    private func steppedDown(requested: CGFloat, floor: CGFloat, fits: (CGFloat) -> Bool) -> CGFloat {
        var scale = requested
        while scale > floor && !fits(scale) {
            scale -= 0.01
        }
        return max(scale, floor)
    }

    private let requestedScales: [CGFloat] = [1, 19.0 / 17, 23.0 / 17, 28.0 / 17, 33.0 / 17, 40.0 / 17, 47.0 / 17, 53.0 / 17]
    private let floors: [CGFloat] = [0.5, 13.0 / 26, 13.0 / 15, 1]

    func testFindsTheScaleTheOneHundredthStepsFoundForEveryLimit() {
        for requested in requestedScales {
            for floor in floors {
                for limit in stride(from: CGFloat(0.4), through: 3.2, by: 0.0037) {
                    let fits = { (scale: CGFloat) in scale <= limit }
                    let found = ScaleSearch.largestFitting(requested: requested, floor: floor, fits: fits)
                    let stepped = steppedDown(requested: requested, floor: floor, fits: fits)
                    XCTAssertEqual(found, stepped, accuracy: ScaleSearch.step, "requested \(requested) floor \(floor) limit \(limit)")
                }
            }
        }
    }

    func testKeepsTheRequestedScaleWhenItFits() {
        var asked: [CGFloat] = []
        let found = ScaleSearch.largestFitting(requested: 53.0 / 17, floor: 1) { scale in
            asked.append(scale)
            return true
        }
        XCTAssertEqual(found, 53.0 / 17)
        XCTAssertEqual(asked, [53.0 / 17])
    }

    func testFallsToTheFloorWhenNothingFits() {
        XCTAssertEqual(ScaleSearch.largestFitting(requested: 2, floor: 1) { _ in false }, 1)
        XCTAssertEqual(ScaleSearch.largestFitting(requested: 0.9, floor: 1) { _ in true }, 1)
    }

    func testMeasuresAFewTimesInsteadOfOnceAStep() {
        var asked = 0
        _ = ScaleSearch.largestFitting(requested: 53.0 / 17, floor: 13.0 / 26) { scale in
            asked += 1
            return scale <= 1.07
        }
        XCTAssertLessThanOrEqual(asked, 10)
    }
}
