import Foundation

public enum ReloadPolicy {
    public static let soonInterval: TimeInterval = 15 * 60
    public static let calmInterval: TimeInterval = 60 * 60
    public static let taskLookahead: TimeInterval = 60 * 60
    public static let renewalLead: TimeInterval = 2 * 60 * 60

    public static func nextReload(
        after now: Date,
        timeline: DeviceTimeline?,
        pressed: Set<PressKey>,
        notBefore: Date? = nil
    ) -> Date {
        let planned = plannedReload(after: now, timeline: timeline, pressed: pressed)
        guard let notBefore else { return planned }
        return max(planned, notBefore)
    }

    public static func needsRenewal(_ timeline: DeviceTimeline, at now: Date) -> Bool {
        timeline.until.timeIntervalSince(now) <= renewalLead
    }

    private static func plannedReload(after now: Date, timeline: DeviceTimeline?, pressed: Set<PressKey>) -> Date {
        guard let timeline else { return now.addingTimeInterval(calmInterval) }
        let interval = taskShowing(timeline, from: now, pressed: pressed) ? soonInterval : calmInterval
        let latest = max(timeline.until.addingTimeInterval(-renewalLead), now.addingTimeInterval(soonInterval))
        return min(now.addingTimeInterval(interval), latest)
    }

    private static func taskShowing(_ timeline: DeviceTimeline, from now: Date, pressed: Set<PressKey>) -> Bool {
        let horizon = now.addingTimeInterval(taskLookahead)
        let instants = [now] + timeline.boundaries(after: now).filter { $0 <= horizon }
        return instants.contains { instant in
            if case .task = timeline.pick(at: instant, pressed: pressed) { return true }
            return false
        }
    }
}
