import AppIntents
import CoreText
import SunnyWidgetCore
import SwiftUI
import WidgetKit

enum TextMeasure {
    static func width(of text: String, style: TypeStyle, scale: CGFloat) -> CGFloat {
        let font = CTFontCreateWithName(style.face.rawValue as CFString, style.size * scale, nil)
        let attributes = [NSAttributedString.Key(kCTFontAttributeName as String): font]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
        return CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    }

    static func lines(_ text: String, style: TypeStyle, scale: CGFloat, width: CGFloat, maxLines: Int) -> [String] {
        LineBreaking.greedy(text, maxLines: maxLines) { candidate in
            Self.width(of: candidate, style: style, scale: scale) <= width
        }
    }
}

struct StyledLine: View {
    let text: String
    let style: TypeStyle
    let scale: CGFloat
    let color: Color

    var body: some View {
        Text(text)
            .font(style.font(scale))
            .foregroundStyle(color)
            .lineLimit(1)
            .minimumScaleFactor(style.shrinkFloor(scale))
            .frame(height: style.line(scale))
    }
}

struct WrappedLines: View {
    let text: String
    let style: TypeStyle
    let scale: CGFloat
    let width: CGFloat
    let maxLines: Int
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            let lines = TextMeasure.lines(text, style: style, scale: scale, width: width, maxLines: maxLines)
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                StyledLine(text: line, style: style, scale: scale, color: color)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}

struct OneLineChoice: View {
    let preferred: String?
    let fallback: String
    let style: TypeStyle
    let scale: CGFloat
    let color: Color

    var body: some View {
        ViewThatFits(in: .horizontal) {
            if let preferred {
                Text(preferred)
                    .font(style.font(scale))
                    .foregroundStyle(color)
                    .fixedSize()
                    .frame(height: style.line(scale))
            }
            StyledLine(text: fallback, style: style, scale: scale, color: color)
        }
    }
}

struct NowTag: View {
    let metrics: WhenMetrics
    let scale: CGFloat
    let inks: Inks

    var body: some View {
        Text(WidgetWords.now)
            .font(metrics.style.font(scale))
            .foregroundStyle(inks.tagText)
            .frame(height: metrics.style.line(scale))
            .padding(.vertical, metrics.tagPaddingVertical * Layout.shrink(scale))
            .padding(.horizontal, metrics.tagPaddingHorizontal * Layout.shrink(scale))
            .background(RoundedRectangle(cornerRadius: Layout.tagRadius, style: .continuous).fill(inks.tagFill))
            .fixedSize()
    }
}

struct WhenLine: View {
    let time: String
    let metrics: WhenMetrics
    let scale: CGFloat
    let inks: Inks

    var body: some View {
        HStack(spacing: metrics.gap * Layout.shrink(scale)) {
            NowTag(metrics: metrics, scale: scale, inks: inks)
            StyledLine(text: time, style: metrics.style, scale: scale, color: inks.text)
        }
        .frame(height: metrics.height(scale), alignment: .leading)
    }
}

struct EmptyWhenLine: View {
    let metrics: WhenMetrics
    let scale: CGFloat

    var body: some View {
        Color.clear
            .frame(height: metrics.height(scale))
            .accessibilityHidden(true)
    }
}

struct DoneKey<Intent: AppIntent>: View {
    let intent: Intent
    let due: DueContent
    let metrics: KeyMetrics
    let width: CGFloat
    let scale: CGFloat
    let inks: Inks

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .continuous)
    }

    private var labelScale: CGFloat {
        let room = width - 2 * Layout.keyTextPadding
        return TypeScale.fitted(requested: scale, floor: metrics.style.shrinkFloor(1)) { candidate in
            metrics.contentWidth(WidgetWords.done, scale: candidate) <= room
        }
    }

    var body: some View {
        Button(intent: intent) {
            HStack(spacing: metrics.gap) {
                Image(systemName: "checkmark")
                    .font(.system(size: metrics.checkSize * labelScale, weight: .bold))
                Text(WidgetWords.done)
                    .font(metrics.style.font(labelScale))
                    .lineLimit(1)
            }
            .foregroundStyle(inks.keyText)
            .frame(maxWidth: .infinity)
            .frame(height: metrics.keyHeight(scale))
            .background { keyBackground }
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(due.doneAccessibilityLabel)
    }

    @ViewBuilder
    private var keyBackground: some View {
        ZStack {
            if let glow = inks.glow {
                shape
                    .fill(Palette.nowYellow.opacity(glow.opacity))
                    .padding(-1)
                    .offset(y: glow.offsetY)
                    .blur(radius: 9)
            }
            shape
                .fill(inks.keyFill)
                .shadow(color: inks.glow == nil ? .clear : Palette.ink.opacity(0.25), radius: 2, x: 0, y: 2)
            if let outline = inks.keyOutline {
                shape.strokeBorder(outline, lineWidth: 3)
            }
        }
    }
}

struct NextPanel: View {
    static let horizontalPadding: CGFloat = 12

    let next: NextContent
    let style: TypeStyle
    let twoRows: Bool
    let height: CGFloat
    let scale: CGFloat
    let inks: Inks

    var body: some View {
        Group {
            if twoRows {
                VStack(spacing: 0) {
                    row(next.leadText)
                    row(next.atTimeText)
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    row(next.panelText).fixedSize()
                    HStack(spacing: 0) {
                        row(next.leadText)
                        row(" " + next.atTimeText).fixedSize()
                    }
                }
            }
        }
        .padding(.horizontal, Self.horizontalPadding)
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(inks.panelFill))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(next.panelText)
    }

    private func row(_ text: String) -> some View {
        Text(text)
            .font(style.font(scale))
            .foregroundStyle(inks.text)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(height: style.line(scale))
    }
}
