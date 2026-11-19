import SunnyWidgetCore
import SwiftUI
import WidgetKit

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

enum Palette {
    static let paper = Color(hex: 0xF7F4EC)
    static let ink = Color(hex: 0x121212)
    static let restingPanel = Color(hex: 0xD9D5CB)
    static let nowYellow = Color(hex: 0xFABF39)
}

enum Face: String {
    case literataBold = "Literata-Bold"
    case atkinsonBold = "AtkinsonHyperlegibleNext-Bold"
    case atkinsonExtraBold = "AtkinsonHyperlegibleNext-ExtraBold"
    case atkinsonMedium = "AtkinsonHyperlegibleNext-Medium"
}

struct TypeStyle {
    static let minimumPointSize: CGFloat = 13

    let face: Face
    let size: CGFloat
    let lineHeight: CGFloat

    func font(_ scale: CGFloat) -> Font {
        .custom(face.rawValue, fixedSize: size * scale)
    }

    func line(_ scale: CGFloat) -> CGFloat {
        lineHeight * scale
    }

    func shrinkFloor(_ scale: CGFloat) -> CGFloat {
        min(1, Self.minimumPointSize / (size * scale))
    }

    static let mediumWhen = TypeStyle(face: .atkinsonExtraBold, size: 17, lineHeight: 22)
    static let mediumSentence = TypeStyle(face: .literataBold, size: 22, lineHeight: 26)
    static let mediumDone = TypeStyle(face: .atkinsonBold, size: 26, lineHeight: 30)
    static let mediumPanel = TypeStyle(face: .atkinsonBold, size: 20, lineHeight: 24)
    static let smallWhen = TypeStyle(face: .atkinsonExtraBold, size: 15, lineHeight: 16)
    static let smallLabel = TypeStyle(face: .literataBold, size: 20, lineHeight: 22)
    static let smallDone = TypeStyle(face: .atkinsonBold, size: 24, lineHeight: 28)
    static let smallPanel = TypeStyle(face: .atkinsonBold, size: 16, lineHeight: 19)
    static let accessoryWhen = TypeStyle(face: .atkinsonExtraBold, size: 15, lineHeight: 16)
    static let accessoryLabel = TypeStyle(face: .literataBold, size: 22, lineHeight: 24)
    static let accessoryDetail = TypeStyle(face: .atkinsonBold, size: 13, lineHeight: 16)
    static let accessoryNotice = TypeStyle(face: .atkinsonBold, size: 15, lineHeight: 18)
    static let bannerWhen = TypeStyle(face: .atkinsonExtraBold, size: 15, lineHeight: 20)
    static let bannerLabel = TypeStyle(face: .literataBold, size: 24, lineHeight: 28)
    static let bannerDetail = TypeStyle(face: .atkinsonMedium, size: 16, lineHeight: 20)
    static let bannerDone = TypeStyle(face: .atkinsonBold, size: 26, lineHeight: 30)
    static let islandWhen = TypeStyle(face: .atkinsonExtraBold, size: 17, lineHeight: 22)
    static let islandSentence = TypeStyle(face: .literataBold, size: 22, lineHeight: 28)
    static let islandDone = TypeStyle(face: .atkinsonBold, size: 26, lineHeight: 30)
    static let compactTag = TypeStyle(face: .atkinsonExtraBold, size: 15, lineHeight: 18)
}

struct WhenMetrics {
    let style: TypeStyle
    let tagPaddingVertical: CGFloat
    let tagPaddingHorizontal: CGFloat
    let gap: CGFloat

    func height(_ scale: CGFloat) -> CGFloat {
        style.line(scale) + 2 * tagPaddingVertical * Layout.shrink(scale)
    }

    func width(time: String, scale: CGFloat) -> CGFloat {
        let tag = TextMeasure.width(of: WidgetWords.now, style: style, scale: scale)
            + 2 * tagPaddingHorizontal * Layout.shrink(scale)
        return tag + gap * Layout.shrink(scale) + TextMeasure.width(of: time, style: style, scale: scale)
    }

    static let medium = WhenMetrics(style: .mediumWhen, tagPaddingVertical: 3, tagPaddingHorizontal: 10, gap: 8)
    static let small = WhenMetrics(style: .smallWhen, tagPaddingVertical: 1, tagPaddingHorizontal: 6, gap: 6)
    static let accessory = WhenMetrics(style: .accessoryWhen, tagPaddingVertical: 1, tagPaddingHorizontal: 6, gap: 6)
    static let banner = WhenMetrics(style: .bannerWhen, tagPaddingVertical: 2, tagPaddingHorizontal: 8, gap: 8)
    static let island = WhenMetrics(style: .islandWhen, tagPaddingVertical: 2, tagPaddingHorizontal: 10, gap: 8)
    static let compact = WhenMetrics(style: .compactTag, tagPaddingVertical: 2, tagPaddingHorizontal: 6.25, gap: 8)
}

struct KeyMetrics {
    let style: TypeStyle
    let checkSize: CGFloat
    let height: CGFloat
    let gap: CGFloat
    let cornerRadius: CGFloat

    func keyHeight(_ scale: CGFloat) -> CGFloat {
        max(Layout.minimumTarget, height * Layout.shrink(scale), style.line(scale) + 12)
    }

    func contentWidth(_ text: String, scale: CGFloat) -> CGFloat {
        checkSize * scale + gap + TextMeasure.width(of: text, style: style, scale: scale)
    }

    static let medium = KeyMetrics(style: .mediumDone, checkSize: 28, height: 48, gap: 8, cornerRadius: 16)
    static let small = KeyMetrics(style: .smallDone, checkSize: 24, height: 48, gap: 8, cornerRadius: 16)
    static let banner = KeyMetrics(style: .bannerDone, checkSize: 26, height: 56, gap: 8, cornerRadius: 16 * 56 / 48)
    static let island = KeyMetrics(style: .islandDone, checkSize: 28, height: 48, gap: 8, cornerRadius: 16)
}

enum Layout {
    static let inset: CGFloat = 18
    static let stackGap: CGFloat = 8
    static let tagRadius: CGFloat = 6
    static let minimumTarget: CGFloat = 44
    static let keyTextPadding: CGFloat = 12

    static func shrink(_ scale: CGFloat) -> CGFloat {
        min(1, scale)
    }

    static func inset(_ scale: CGFloat) -> CGFloat {
        inset * shrink(scale)
    }

    static func gap(_ scale: CGFloat) -> CGFloat {
        stackGap * shrink(scale)
    }
}

struct Glow {
    let opacity: Double
    let offsetY: CGFloat

    static let key = Glow(opacity: 1, offsetY: 8)
    static let island = Glow(opacity: 0.85, offsetY: 6)
}

struct Inks {
    let text: Color
    let tagFill: Color
    let tagText: Color
    let keyFill: Color
    let keyText: Color
    let keyOutline: Color?
    let panelFill: Color
    let glow: Glow?

    static func forMode(_ mode: WidgetRenderingMode) -> Inks {
        mode == .fullColor ? .fullColor : .monochrome
    }

    static let fullColor = Inks(
        text: Palette.ink,
        tagFill: Palette.nowYellow,
        tagText: Palette.ink,
        keyFill: Palette.ink,
        keyText: Palette.paper,
        keyOutline: nil,
        panelFill: Palette.restingPanel,
        glow: .key
    )

    static let island = Inks(
        text: .white,
        tagFill: Palette.nowYellow,
        tagText: Palette.ink,
        keyFill: Palette.paper,
        keyText: Palette.ink,
        keyOutline: nil,
        panelFill: Palette.restingPanel,
        glow: .island
    )

    static let monochrome = Inks(
        text: .white,
        tagFill: .white.opacity(0.25),
        tagText: .white,
        keyFill: .white.opacity(0.15),
        keyText: .white,
        keyOutline: .white,
        panelFill: .white.opacity(0.15),
        glow: nil
    )
}

enum TypeScale {
    private static let bodyPoints: [DynamicTypeSize: CGFloat] = [
        .xSmall: 14, .small: 15, .medium: 16, .large: 17, .xLarge: 19, .xxLarge: 21, .xxxLarge: 23,
        .accessibility1: 28, .accessibility2: 33, .accessibility3: 40, .accessibility4: 47, .accessibility5: 53,
    ]

    static let circularCap = DynamicTypeSize.xLarge

    static func factor(_ size: DynamicTypeSize, cap: DynamicTypeSize = .accessibility5) -> CGFloat {
        let points = bodyPoints[min(size, cap)] ?? 17
        return max(1, points / 17)
    }

    static func fitted(requested: CGFloat, floor: CGFloat, fits: (CGFloat) -> Bool) -> CGFloat {
        var scale = requested
        while scale > floor && !fits(scale) {
            scale -= 0.01
        }
        return max(scale, floor)
    }
}
