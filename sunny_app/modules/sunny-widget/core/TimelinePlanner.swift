import Foundation

public struct PlannedEntry: Equatable, Sendable {
    public let date: Date
    public let content: WidgetContent
}

public struct TimelinePlan: Equatable, Sendable {
    public let entries: [PlannedEntry]
    public let reloadAt: Date
}

public enum TimelinePlanner {
    public static func notice(_ notice: Notice, at now: Date) -> TimelinePlan {
        TimelinePlan(
            entries: [PlannedEntry(date: now, content: .notice(notice))],
            reloadAt: ReloadPolicy.nextReload(after: now, timeline: nil, pressed: [])
        )
    }

    public static func plan(
        at now: Date,
        timeline: DeviceTimeline?,
        pressed: Set<PressKey>,
        locale: Locale,
        notBefore: Date? = nil
    ) -> TimelinePlan {
        guard let timeline, timeline.covers(now) else {
            return TimelinePlan(
                entries: [PlannedEntry(date: now, content: .notice(.notConnected))],
                reloadAt: ReloadPolicy.nextReload(after: now, timeline: timeline, pressed: pressed, notBefore: notBefore)
            )
        }
        let instants = [now] + timeline.boundaries(after: now)
        var entries = instants.compactMap { instant -> PlannedEntry? in
            guard let pick = timeline.pick(at: instant, pressed: pressed) else { return nil }
            return PlannedEntry(
                date: instant,
                content: WidgetContent.from(pick, timeZone: timeline.timeZone, locale: locale)
            )
        }
        entries.append(PlannedEntry(date: timeline.until, content: .notice(.notConnected)))
        return TimelinePlan(
            entries: entries,
            reloadAt: ReloadPolicy.nextReload(after: now, timeline: timeline, pressed: pressed, notBefore: notBefore)
        )
    }
}
