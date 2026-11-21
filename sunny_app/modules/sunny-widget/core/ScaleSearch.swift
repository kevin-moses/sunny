import Foundation

public enum ScaleSearch {
    public static let step: CGFloat = 0.01

    public static func largestFitting(requested: CGFloat, floor: CGFloat, fits: (CGFloat) -> Bool) -> CGFloat {
        guard requested > floor else { return floor }
        if fits(requested) { return requested }
        var low = 1
        var high = Int(((requested - floor) / step).rounded(.up))
        while low < high {
            let middle = (low + high) / 2
            if fits(requested - CGFloat(middle) * step) {
                high = middle
            } else {
                low = middle + 1
            }
        }
        return max(requested - CGFloat(high) * step, floor)
    }
}
