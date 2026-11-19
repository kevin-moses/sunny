import SunnyWidgetCore
import SwiftUI
import WidgetKit

struct SunnyWidgetView: View {
    let content: WidgetContent

    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        GeometryReader { geometry in
            familyView(size: geometry.size)
        }
        .containerBackground(for: .widget) { Palette.paper }
    }

    @ViewBuilder
    private func familyView(size: CGSize) -> some View {
        switch family {
        case .systemSmall:
            system(.small, size: size)
        case .accessoryInline:
            InlineAccessoryView(content: content)
        case .accessoryRectangular:
            RectangularAccessoryView(content: content, size: size, requestedScale: TypeScale.factor(dynamicTypeSize))
        case .accessoryCircular:
            CircularAccessoryView(
                content: content,
                scale: TypeScale.factor(dynamicTypeSize, cap: TypeScale.circularCap)
            )
        default:
            system(.medium, size: size)
        }
    }

    private func system(_ layout: SystemWidgetLayout, size: CGSize) -> some View {
        SystemWidgetView(
            content: content,
            layout: layout,
            size: size,
            requestedScale: TypeScale.factor(dynamicTypeSize),
            inks: Inks.forMode(renderingMode)
        )
    }
}
