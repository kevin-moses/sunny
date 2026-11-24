import SunnyWidgetCore
import SwiftUI

enum ActivityLayout {
    static let bannerInset: CGFloat = 14
    static let bannerVerticalInset: CGFloat = 16
    static let bannerColumnGap: CGFloat = 12
    static let bannerLineGap: CGFloat = 4
    static let bannerKeyWidth: CGFloat = 132
    static let islandKeyWidth: CGFloat = 336
    static let islandRowGap: CGFloat = 8
    static let compactSymbolSize: CGFloat = 22
    static let compactCheckSize: CGFloat = 18
    static let compactDotSize: CGFloat = 12
    static let overOpacity: Double = 0.5
    static let receiptStyle = TypeStyle.mediumPanel
}

extension TaskActivityFace {
    var isOver: Bool {
        if case .over = self { return true }
        return false
    }

    var symbolName: String {
        if case .receipt = self { return "checkmark" }
        return content.symbolName
    }
}

struct DoneIntentKey: View {
    let due: DueContent
    let metrics: KeyMetrics
    let width: CGFloat
    let inks: Inks

    var body: some View {
        DoneKey(
            intent: ConfirmActivityIntent(instanceId: due.instanceId, step: due.step),
            due: due,
            metrics: metrics,
            width: width,
            scale: 1,
            inks: inks
        )
    }
}

struct ReceiptKey: View {
    let noted: String
    let metrics: KeyMetrics
    let fill: Color
    let text: Color

    var body: some View {
        Text(noted)
            .font(ActivityLayout.receiptStyle.font(1))
            .foregroundStyle(text)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(ActivityLayout.receiptStyle.shrinkFloor(1))
            .padding(.horizontal, Layout.keyTextPadding)
            .frame(maxWidth: .infinity)
            .frame(height: metrics.keyHeight(1))
            .background(RoundedRectangle(cornerRadius: metrics.cornerRadius, style: .continuous).fill(fill))
    }
}

struct LockScreenTaskView: View {
    let face: TaskActivityFace

    private let inks = Inks.fullColor

    var body: some View {
        let due = face.content
        HStack(spacing: ActivityLayout.bannerColumnGap) {
            VStack(alignment: .leading, spacing: ActivityLayout.bannerLineGap) {
                when(due)
                StyledLine(text: due.label, style: .bannerLabel, scale: 1, color: inks.text)
                if let second = due.secondLine {
                    StyledLine(text: second, style: .bannerDetail, scale: 1, color: inks.text)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([due.label, due.secondLine].compactMap { $0 }.joined(separator: ", "))
            trailing(due)
        }
        .padding(.horizontal, ActivityLayout.bannerInset)
        .padding(.vertical, ActivityLayout.bannerVerticalInset)
        .opacity(face.isOver ? ActivityLayout.overOpacity : 1)
    }

    @ViewBuilder
    private func when(_ due: DueContent) -> some View {
        if case .due = face {
            WhenLine(time: due.time, metrics: .banner, scale: 1, inks: inks)
        } else {
            StyledLine(text: due.time, style: .bannerWhen, scale: 1, color: inks.text)
                .frame(height: WhenMetrics.banner.height(1), alignment: .leading)
        }
    }

    @ViewBuilder
    private func trailing(_ due: DueContent) -> some View {
        switch face {
        case .due:
            DoneIntentKey(due: due, metrics: .banner, width: ActivityLayout.bannerKeyWidth, inks: inks)
                .frame(width: ActivityLayout.bannerKeyWidth)
        case .receipt(_, let noted):
            ReceiptKey(noted: noted, metrics: .banner, fill: inks.panelFill, text: inks.text)
                .frame(width: ActivityLayout.bannerKeyWidth)
        case .over:
            EmptyView()
        }
    }
}

struct IslandLeadingView: View {
    let face: TaskActivityFace

    var body: some View {
        switch face {
        case .due:
            NowTag(metrics: .island, scale: 1, inks: .island)
        case .receipt, .over:
            Image(systemName: face.symbolName)
                .font(.system(size: ActivityLayout.compactSymbolSize, weight: .bold))
                .foregroundStyle(.white)
        }
    }
}

struct IslandTrailingView: View {
    let face: TaskActivityFace

    var body: some View {
        StyledLine(text: face.content.time, style: .islandWhen, scale: 1, color: .white)
            .frame(height: WhenMetrics.island.height(1))
            .opacity(face.isOver ? ActivityLayout.overOpacity : 1)
    }
}

struct IslandBottomView: View {
    let face: TaskActivityFace

    var body: some View {
        let due = face.content
        VStack(alignment: .leading, spacing: ActivityLayout.islandRowGap) {
            OneLineChoice(preferred: due.line, fallback: due.label, style: .islandSentence, scale: 1, color: .white)
                .accessibilityLabel(due.line ?? due.label)
                .opacity(face.isOver ? ActivityLayout.overOpacity : 1)
            switch face {
            case .due:
                DoneIntentKey(due: due, metrics: .island, width: ActivityLayout.islandKeyWidth, inks: .island)
            case .receipt(_, let noted):
                ReceiptKey(noted: noted, metrics: .island, fill: .white.opacity(0.15), text: .white)
            case .over:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct TaskSymbolView: View {
    let face: TaskActivityFace

    var body: some View {
        Image(systemName: face.symbolName)
            .font(.system(size: ActivityLayout.compactSymbolSize, weight: .bold))
            .foregroundStyle(.white)
            .opacity(face.isOver ? ActivityLayout.overOpacity : 1)
            .accessibilityLabel(face.content.label)
    }
}

struct CompactTrailingView: View {
    let face: TaskActivityFace

    var body: some View {
        switch face {
        case .due:
            ViewThatFits(in: .horizontal) {
                NowTag(metrics: .compact, scale: 1, inks: .island)
                Circle()
                    .fill(Palette.nowYellow)
                    .frame(width: ActivityLayout.compactDotSize, height: ActivityLayout.compactDotSize)
            }
            .accessibilityLabel(WidgetWords.now)
        case .receipt:
            Image(systemName: "checkmark")
                .font(.system(size: ActivityLayout.compactCheckSize, weight: .bold))
                .foregroundStyle(Palette.nowYellow)
        case .over:
            EmptyView()
        }
    }
}
