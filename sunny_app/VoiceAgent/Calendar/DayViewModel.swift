// Calendar/DayViewModel.swift
//
// Purpose: The day clock data both senior surfaces render (the phone's Today view and the
// home display), loaded from the get_day_view RPC: the orientation header ("Monday
// evening"), today's tasks and events, Next up and the coming week. Times arrive already
// in the household's local time ("14:00:00", "2026-10-29"), so the app only formats them.
// Refreshes every 30 seconds and when the app returns to the foreground (dayRefresh); a
// failed refresh keeps the last good day on screen and marks it offline. If the server
// says this device no longer belongs to the household (403), the device is unpaired.
//
// Last modified: 2026-10-27

import Foundation
import Observation
import SwiftUI

/// One occurrence of a calendar event, in household-local terms.
struct EventOccurrence: Decodable, Identifiable, Equatable {
    let eventId: String
    let label: String
    let localDate: String
    let startTime: String
    let place: String?
    let visitorName: String?

    var id: String {
        "\(eventId)-\(localDate)"
    }
}

/// One of today's task instances (medication, routine, reminder).
struct DayTask: Decodable, Identifiable, Equatable {
    let instanceId: String
    let displayLabel: String
    let scheduledTime: String
    let state: String

    var id: String {
        instanceId
    }

    /// True once the senior or a caregiver confirmed it.
    var isDone: Bool {
        state == "confirmed" || state == "resolved"
    }

    /// True while its confirmation window is open.
    var isDue: Bool {
        state == "due" || state == "escalated"
    }
}

/// The get_day_view fields the surfaces render.
struct DayViewData: Decodable, Equatable {
    let localDate: String
    let dateLabel: String
    let header: String
    let tasks: [DayTask]
    let eventsToday: [EventOccurrence]
    let nextUp: EventOccurrence?
    let upcoming: [EventOccurrence]
}

/// A line in today's agenda: a task or an event, ordered by time.
enum AgendaItem: Identifiable {
    case task(DayTask)
    case event(EventOccurrence)

    var id: String {
        switch self {
        case let .task(task): "task-\(task.id)"
        case let .event(event): "event-\(event.id)"
        }
    }

    /// Local start time "HH:MM:SS", used for ordering.
    var time: String {
        switch self {
        case let .task(task): task.scheduledTime
        case let .event(event): event.startTime
        }
    }
}

/// Loads and periodically refreshes the household's day view.
@MainActor
@Observable
final class DayViewModel {
    private(set) var day: DayViewData?
    private(set) var errorMessage: String?

    /// True when the latest refresh failed and the screen shows the last good day.
    var isOffline: Bool {
        errorMessage != nil
    }

    private let householdId: String
    private var refreshTask: Task<Void, Never>?

    private static let timeParser = formatter("HH:mm:ss", posix: true)
    private static let timeFormatter = formatter("h:mm a", posix: false)
    private static let dateParser = formatter("yyyy-MM-dd", posix: true)
    private static let weekdayFormatter = formatter("EEEE", posix: false)

    /// purpose: Make a fixed-format formatter on the UTC calendar (dates and times here
    ///          are already household-local, so no timezone conversion happens).
    /// @param format: (String) Date format.
    /// @param posix: (Bool) Parse with the POSIX locale (machine formats).
    /// @return DateFormatter
    private static func formatter(_ format: String, posix: Bool) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC")
        if posix { formatter.locale = Locale(identifier: "en_US_POSIX") }
        formatter.dateFormat = format
        return formatter
    }

    /// purpose: Create the model for a paired household.
    /// @param householdId: (String) Household the device is paired with.
    /// @param day: (DayViewData?) Initial data (previews and tests); normally loaded.
    init(householdId: String, day: DayViewData? = nil) {
        self.householdId = householdId
        self.day = day
    }

    /// purpose: Load now, then every 30 seconds until stop(); calling it again restarts
    ///          the timer, so returning to the foreground refreshes exactly once.
    func start() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    /// purpose: Stop the periodic refresh.
    func stop() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    /// purpose: Fetch the day view once. Keeps the last good data on failure; unpairs the
    ///          device when the server says it no longer belongs to the household (403).
    func refresh() async {
        do {
            day = try await SunnyBackend.shared.rpc("get_day_view", ["p_household_id": householdId])
            errorMessage = nil
        } catch let SunnyBackendError.server(status, _) where status == 403 {
            // The device was removed from the household.
            await SunnyBackend.shared.unpair()
        } catch is CancellationError {
            // A newer refresh replaced this one.
        } catch let error as URLError where error.code == .cancelled {
            // Same, surfaced by URLSession.
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Today's tasks and events in time order.
    var agenda: [AgendaItem] {
        guard let day else { return [] }
        return (day.tasks.map(AgendaItem.task) + day.eventsToday.map(AgendaItem.event)).sorted { $0.time < $1.time }
    }

    /// purpose: Display form of a local "HH:MM:SS" time, e.g. "2:00 PM".
    /// @param localTime: (String) Time from the database.
    /// @return (String) Display time.
    func displayTime(_ localTime: String) -> String {
        guard let date = Self.timeParser.date(from: localTime) else { return localTime }
        return Self.timeFormatter.string(from: date)
    }

    /// purpose: When an event happens, relative to today: "Today at 2:00 PM",
    ///          "Tomorrow at 9:00 AM" or "Thursday at 2:00 PM".
    /// @param event: (EventOccurrence) The occurrence.
    /// @return (String) Calm, plain description.
    func whenText(_ event: EventOccurrence) -> String {
        let time = displayTime(event.startTime)
        guard let day, let today = Self.dateParser.date(from: day.localDate),
              let date = Self.dateParser.date(from: event.localDate)
        else { return time }
        switch Int(date.timeIntervalSince(today) / 86400) {
        case 0: return "Today at \(time)"
        case 1: return "Tomorrow at \(time)"
        default: return "\(Self.weekdayFormatter.string(from: date)) at \(time)"
        }
    }
}

extension View {
    /// purpose: Keep a DayViewModel fresh while the view is on screen: start on appear,
    ///          stop on disappear, restart when the app becomes active again.
    /// @param model: (DayViewModel) The model to refresh.
    /// @return The modified view.
    func dayRefresh(_ model: DayViewModel) -> some View {
        modifier(DayRefresh(model: model))
    }
}

/// See View.dayRefresh(_:).
private struct DayRefresh: ViewModifier {
    let model: DayViewModel
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onAppear { model.start() }
            .onDisappear { model.stop() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { model.start() }
            }
    }
}
