import SunnyWidgetCore
import SwiftUI
import WidgetKit

struct SunnyEntry: TimelineEntry {
    let date: Date
    let content: WidgetContent

    init(date: Date, content: WidgetContent) {
        self.date = date
        self.content = content
    }

    init(_ planned: PlannedEntry) {
        self.init(date: planned.date, content: planned.content)
    }

    static func gallerySample(at date: Date) -> SunnyEntry {
        let calendar = Calendar.autoupdatingCurrent
        let nineThirty = calendar.date(bySettingHour: 9, minute: 30, second: 0, of: date) ?? date
        let time = ClockFormat.time(nineThirty, in: calendar.timeZone, locale: .autoupdatingCurrent)
        return SunnyEntry(
            date: date,
            content: .due(
                DueContent(
                    instanceId: "",
                    step: 0,
                    time: time,
                    label: "Morning pills",
                    line: "Take your morning pills.",
                    stepLine: nil,
                    detail: "the small white ones",
                    icon: .pills
                )
            )
        )
    }
}

struct SunnyProvider: TimelineProvider {
    func placeholder(in context: Context) -> SunnyEntry {
        .gallerySample(at: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (SunnyEntry) -> Void) {
        if context.isPreview {
            completion(.gallerySample(at: Date()))
            return
        }
        let plan = WidgetSync.live()?.cachedPlan(locale: .autoupdatingCurrent)
            ?? TimelinePlanner.notice(.openSunny, at: Date())
        completion(plan.entries.first.map(SunnyEntry.init) ?? SunnyEntry(date: Date(), content: .notice(.openSunny)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SunnyEntry>) -> Void) {
        Task {
            let plan = await WidgetSync.live()?.refresh(locale: .autoupdatingCurrent)
                ?? TimelinePlanner.notice(.openSunny, at: Date())
            completion(Timeline(entries: plan.entries.map(SunnyEntry.init), policy: .after(plan.reloadAt)))
        }
    }
}

struct SunnyWidget: Widget {
    static let kind = "SunnyToday"

    var body: some WidgetConfiguration {
        if #available(iOS 26.0, *) {
            return configuration.pushHandler(WidgetPushTokenHandler.self)
        } else {
            return configuration
        }
    }

    private var configuration: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: SunnyProvider()) { entry in
            SunnyWidgetView(content: entry.content)
        }
        .configurationDisplayName("Sunny")
        .description("Shows the task that is due now with a Done button, or what comes next.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryInline, .accessoryRectangular, .accessoryCircular])
        .contentMarginsDisabled()
    }
}

@main
struct SunnyWidgetBundle: WidgetBundle {
    var body: some Widget {
        SunnyWidget()
        TaskLiveActivity()
    }
}
