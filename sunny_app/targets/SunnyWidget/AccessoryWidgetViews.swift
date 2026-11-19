import SunnyWidgetCore
import SwiftUI
import WidgetKit

struct InlineAccessoryView: View {
    let content: WidgetContent

    var body: some View {
        switch content {
        case .due(let due):
            Label(due.inlineText, systemImage: due.symbolName)
        case .clear(let clear):
            if let next = clear.next {
                ViewThatFits {
                    Text(next.shortText)
                    Text(next.shortestText)
                }
            } else {
                Text(WidgetWords.appName)
            }
        case .notice(let notice):
            ViewThatFits {
                Text(notice.text)
                Text(WidgetWords.appName)
            }
        }
    }
}

struct RectangularAccessoryView: View {
    static let gap: CGFloat = 2
    static let noticeMaxLines = 3

    let content: WidgetContent
    let size: CGSize
    let requestedScale: CGFloat

    private let inks = Inks.monochrome

    private var width: CGFloat { size.width }

    static func contentHeight(_ content: WidgetContent, width: CGFloat, scale: CGFloat) -> CGFloat {
        let when = WhenMetrics.accessory.height(scale) + gap
        let label = TypeStyle.accessoryLabel.line(scale)
        switch content {
        case .due(let due):
            let detail = due.detail == nil ? 0 : gap + TypeStyle.accessoryDetail.line(scale)
            return when + label + detail
        case .clear(let clear):
            return clear.next == nil ? label : when + label
        case .notice(let notice):
            let lines = TextMeasure.lines(notice.text, style: .accessoryNotice, scale: scale, width: width, maxLines: noticeMaxLines)
            return CGFloat(max(1, lines.count)) * TypeStyle.accessoryNotice.line(scale)
        }
    }

    var body: some View {
        let scale = TypeScale.fitted(requested: requestedScale, floor: 1) { scale in
            Self.contentHeight(content, width: width, scale: scale) <= size.height
        }
        VStack(alignment: .leading, spacing: Self.gap) {
            switch content {
            case .due(let due):
                WhenLine(time: due.time, metrics: .accessory, scale: scale, inks: inks, symbol: due.symbolName)
                StyledLine(text: due.label, style: .accessoryLabel, scale: scale, color: inks.text)
                if let detail = due.detail {
                    StyledLine(text: detail, style: .accessoryDetail, scale: scale, color: inks.text)
                }
            case .clear(let clear):
                if let next = clear.next {
                    HStack(spacing: WhenMetrics.accessory.gap) {
                        StyledLine(text: WidgetWords.next, style: .accessoryWhen, scale: scale, color: inks.text)
                        StyledLine(text: next.time, style: .accessoryWhen, scale: scale, color: inks.text)
                    }
                    .frame(height: WhenMetrics.accessory.height(scale))
                    StyledLine(text: next.label, style: .accessoryLabel, scale: scale, color: inks.text)
                } else {
                    StyledLine(text: WidgetWords.appName, style: .accessoryLabel, scale: scale, color: inks.text)
                }
            case .notice(let notice):
                WrappedLines(
                    text: notice.text,
                    style: .accessoryNotice,
                    scale: scale,
                    width: width,
                    maxLines: Self.noticeMaxLines,
                    color: inks.text
                )
            }
        }
        .frame(width: size.width, height: size.height, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct CircularAccessoryView: View {
    let content: WidgetContent
    let scale: CGFloat

    private let style = TypeStyle.accessoryWhen

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 2) {
                switch content {
                case .due(let due):
                    Image(systemName: due.symbolName)
                        .font(.system(size: 20 * scale, weight: .bold))
                    StyledLine(text: due.time, style: style, scale: scale, color: .white)
                case .clear(let clear):
                    if let next = clear.next {
                        StyledLine(text: WidgetWords.next, style: style, scale: scale, color: .white)
                        StyledLine(text: next.time, style: style, scale: scale, color: .white)
                    } else {
                        StyledLine(text: WidgetWords.appName, style: style, scale: scale, color: .white)
                    }
                case .notice:
                    StyledLine(text: WidgetWords.appName, style: style, scale: scale, color: .white)
                }
            }
            .padding(.horizontal, 6)
        }
        .accessibilityElement(children: .combine)
    }
}
