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

    func contentHeight(_ content: WidgetContent, width: CGFloat, scale: CGFloat) -> CGFloat {
        let gap = Layout.gap(scale)
        let top = when.height(scale) + gap
        let lineCount = { (text: String, maxLines: Int) in
            CGFloat(max(1, TextMeasure.lines(text, style: line, scale: scale, width: width, maxLines: maxLines).count))
        }
        switch content {
        case .due(let due):
            let lines = showsSentence ? 1 : lineCount(due.label, lineMaxLines)
            return top + lines * line.line(scale) + gap + key.keyHeight(scale)
        case .clear(let clear):
            let panel = clear.next == nil ? 0 : gap + panelHeight(scale)
            return top + lineCount(clear.headline, lineMaxLines) * line.line(scale) + panel
        case .notice(let notice):
            return top + lineCount(notice.text, noticeMaxLines) * line.line(scale)
        }
    }

    func whenLineFits(_ content: WidgetContent, width: CGFloat, scale: CGFloat) -> Bool {
        guard case .due(let due) = content else { return true }
        return when.width(time: due.time, scale: scale) <= width
    }

    func fittedScale(_ content: WidgetContent, size: CGSize, requested: CGFloat) -> CGFloat {
        TypeScale.fitted(requested: requested, floor: TypeStyle.minimumPointSize / smallestTextSize) { scale in
            let box = inner(size, scale: scale)
            return contentHeight(content, width: box.width, scale: scale) <= box.height
                && whenLineFits(content, width: box.width, scale: scale)
        }
    }
}

struct SystemWidgetView: View {
    let content: WidgetContent
    let layout: SystemWidgetLayout
    let size: CGSize
    let requestedScale: CGFloat
    let inks: Inks

    var body: some View {
        let scale = layout.fittedScale(content, size: size, requested: requestedScale)
        let box = layout.inner(size, scale: scale)
        VStack(alignment: .leading, spacing: Layout.gap(scale)) {
            switch content {
            case .due(let due):
                VStack(alignment: .leading, spacing: Layout.gap(scale)) {
                    WhenLine(time: due.time, metrics: layout.when, scale: scale, inks: inks)
                    dueLine(due, width: box.width, scale: scale)
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
                wrapped(clear.headline, maxLines: layout.lineMaxLines, width: box.width, scale: scale)
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
                wrapped(notice.text, maxLines: layout.noticeMaxLines, width: box.width, scale: scale)
            }
        }
        .frame(width: box.width, height: box.height, alignment: .topLeading)
        .padding(Layout.inset(scale))
    }

    @ViewBuilder
    private func dueLine(_ due: DueContent, width: CGFloat, scale: CGFloat) -> some View {
        if layout.showsSentence {
            OneLineChoice(preferred: due.line, fallback: due.label, style: layout.line, scale: scale, color: inks.text)
        } else {
            wrapped(due.label, maxLines: layout.lineMaxLines, width: width, scale: scale)
        }
    }

    private func wrapped(_ text: String, maxLines: Int, width: CGFloat, scale: CGFloat) -> some View {
        WrappedLines(text: text, style: layout.line, scale: scale, width: width, maxLines: maxLines, color: inks.text)
    }
}
