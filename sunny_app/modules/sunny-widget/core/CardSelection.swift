import Foundation

public enum CardPick: Equatable, Sendable {
    case task(TaskCard)
    case clear(ClearCard)
}

extension DeviceTimeline {
    public func covers(_ date: Date) -> Bool {
        date < until
    }

    public func slice(at date: Date) -> TimelineSlice? {
        guard covers(date) else { return nil }
        return slices.last { $0.at <= date } ?? slices.first
    }

    public func pick(at date: Date, pressed: Set<PressKey>) -> CardPick? {
        guard let slice = slice(at: date) else { return nil }
        return Self.pick(from: slice, pressed: pressed)
    }

    public func boundaries(after date: Date) -> [Date] {
        slices.map(\.at).filter { $0 > date && $0 < until }
    }

    static func pick(from slice: TimelineSlice, pressed: Set<PressKey>) -> CardPick? {
        for card in slice.cards {
            switch card {
            case .task(let task) where !pressed.contains(task.key):
                return .task(task)
            case .task:
                continue
            case .clear(let clear):
                return .clear(clear)
            }
        }
        return nil
    }
}
