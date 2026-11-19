import ActivityKit
import SunnyWidgetCore
import SwiftUI
import WidgetKit

struct TaskLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SunnyTaskAttributes.self) { context in
            LockScreenTaskView(face: Self.face(context))
                .activityBackgroundTint(Palette.paper)
                .activitySystemActionForegroundColor(Palette.ink)
        } dynamicIsland: { context in
            let face = Self.face(context)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { IslandLeadingView(face: face) }
                DynamicIslandExpandedRegion(.trailing) { IslandTrailingView(face: face) }
                DynamicIslandExpandedRegion(.bottom) { IslandBottomView(face: face) }
            } compactLeading: {
                TaskSymbolView(face: face)
            } compactTrailing: {
                CompactTrailingView(face: face)
            } minimal: {
                TaskSymbolView(face: face)
            }
            .keylineTint(Palette.nowYellow)
        }
    }

    private static func face(_ context: ActivityViewContext<SunnyTaskAttributes>) -> TaskActivityFace {
        TaskActivityFace(
            state: context.state,
            isStale: context.isStale,
            timeZone: WidgetSync.live()?.householdTimeZone() ?? .autoupdatingCurrent,
            locale: .autoupdatingCurrent
        )
    }
}
