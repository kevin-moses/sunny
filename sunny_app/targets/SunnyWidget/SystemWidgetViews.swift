import SunnyWidgetCore
import SwiftUI

struct SystemWidgetLayout {
    let when: WhenMetrics
    let line: TypeStyle
    let lineMaxLines: Int
    let key: KeyMetrics
    let panel: TypeStyle
    let panelRows: Int
    let noticeMaxLines: Int
    let showsSentence: Bool

    static let medium = SystemWidgetLayout(
        when: .medium,
        line: .mediumSentence,
        lineMaxLines: 1,
        key: .medium,
        panel: .mediumPanel,
        panelRows: 1,
        noticeMaxLines: 2,
        showsSentence: true
    )

    static let small = SystemWidgetLayout(
        when: .small,
        line: .smallLabel,
        lineMaxLines: 2,
        key: .small,
        panel: .smallPanel,
        panelRows: 2,
        noticeMaxLines: 4,
        showsSentence: false
    )

    var smallestTextSize: CGFloat {
        [when.style.size, line.size, key.style.size, panel.size].min() ?? TypeStyle.minimumPointSize
    }

    func panelHeight(_ scale: CGFloat) -> CGFloat {
        max(key.height * Layout.shrink(scale), CGFloat(panelRows) * panel.line(scale) + 8)
    }

    func inner(_ size: CGSize, scale: CGFloat) -> CGSize {
        let inset = 2 * Layout.inset(scale)
        return CGSize(width: size.width - inset, height: size.height - inset)
    }

    func wrappedText(_ content: WidgetContent) -> (text: String, maxLines: Int)? {
        switch content {
        case .due(let due):
            return showsSentence ? nil : (due.label, lineMaxLines)
        case .clear(let clear):
            return (clear.headline, lineMaxLines)
        case .notice(let notice):
            return (notice.text, noticeMaxLines)
        }
    }

    func lines(_ content: WidgetContent, width: CGFloat, scale: CGFloat) -> [String] {
        guard let wrapped = wrappedText(content) else { return [] }
        return TextMeasure.lines(wrapped.text, style: line, scale: scale, width: width, maxLines: wrapped.maxLines)
    }

    func contentHeight(_ content: WidgetContent, lineCount: Int, scale: CGFloat) -> CGFloat {
        let gap = Layout.gap(scale)
        let text = when.height(scale) + gap + CGFloat(max(1, lineCount)) * line.line(scale)
        switch content {
        case .due:
            return text + gap + key.keyHeight(scale)
        case .clear(let clear):
            return text + (clear.next == nil ? 0 : gap + panelHeight(scale))
        case .notice:
            return text
        }
    }

    func whenLineFits(_ content: WidgetContent, width: CGFloat, scale: CGFloat) -> Bool {
        guard case .due(let due) = content else { return true }
        return when.width(time: due.time, scale: scale) <= width
    }

    func fitted(_ content: WidgetContent, size: CGSize, requested: CGFloat) -> (scale: CGFloat, lines: [String]) {
        let fit = TypeScale.fitted(
            requested: requested,
            floor: TypeStyle.minimumPointSize / smallestTextSize,
            measure: { scale in lines(content, width: inner(size, scale: scale).width, scale: scale) },
            fits: { lines, scale in
                let box = inner(size, scale: scale)
                return contentHeight(content, lineCount: lines.count, scale: scale) <= box.height
                    && whenLineFits(content, width: box.width, scale: scale)
            }
        )
        return (fit.scale, fit.measured)
    }
}

struct SystemWidgetView: View {
    let content: WidgetContent
    let layout: SystemWidgetLayout
    let size: CGSize
    let requestedScale: CGFloat
    let inks: Inks

    var body: some View {
        let fit = layout.fitted(content, size: size, requested: requestedScale)
        let scale = fit.scale
        let box = layout.inner(size, scale: scale)
        VStack(alignment: .leading, spacing: Layout.gap(scale)) {
            switch content {
            case .due(let due):
                VStack(alignment: .leading, spacing: Layout.gap(scale)) {
                    WhenLine(time: due.time, metrics: layout.when, scale: scale, inks: inks)
                    dueLine(due, lines: fit.lines, scale: scale)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(due.spokenSummary)
                DoneKey(
                    intent: ConfirmTaskIntent(instanceId: due.instanceId, step: due.step),
                    due: due,
                    metrics: layout.key,
                    width: box.width,
                    scale: scale,
                    inks: inks
                )
            case .clear(let clear):
                EmptyWhenLine(metrics: layout.when, scale: scale)
                wrapped(clear.headline, lines: fit.lines, scale: scale)
                if let next = clear.next {
                    NextPanel(
                        next: next,
                        style: layout.panel,
                        twoRows: layout.panelRows > 1,
                        height: layout.panelHeight(scale),
                        scale: scale,
                        inks: inks
                    )
                }
            case .notice(let notice):
                EmptyWhenLine(metrics: layout.when, scale: scale)
                wrapped(notice.text, lines: fit.lines, scale: scale)
            }
        }
        .frame(width: box.width, height: box.height, alignment: .topLeading)
        .padding(Layout.inset(scale))
    }

    @ViewBuilder
    private func dueLine(_ due: DueContent, lines: [String], scale: CGFloat) -> some View {
        if layout.showsSentence {
            OneLineChoice(preferred: due.line, fallback: due.label, style: layout.line, scale: scale, color: inks.text)
        } else {
            wrapped(due.label, lines: lines, scale: scale)
        }
    }

    private func wrapped(_ text: String, lines: [String], scale: CGFloat) -> some View {
        WrappedLines(text: text, lines: lines, style: layout.line, scale: scale, color: inks.text)
    }
}
