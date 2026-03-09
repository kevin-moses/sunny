// Services/EventKitReminderService.swift
//
// Purpose: Creates EKReminder entries using EventKit. Called by AppViewModel's
// "createReminder" RPC handler. Logs authorization status, calendar selection,
// and save result via SunnyLogger for cross-side debugging.
//
// Last modified: 2026-03-03

import EventKit
import Foundation

/// Service for creating reminders using EventKit.
final class EventKitReminderService: ObservableObject {
    private let eventStore = EKEventStore()

    /// Create a reminder with the given parameters
    func createReminder(title: String, notes: String = "", dueDate: String = "") throws -> String {
        // Debug: authorization and calendars
        let authStatus = EKEventStore.authorizationStatus(for: .reminder)
        SunnyLogger.shared.debug("EventKit", "Reminders auth status: \(authStatus.rawValue)")
        let reminderCalendars = eventStore.calendars(for: .reminder)
        SunnyLogger.shared.debug("EventKit", "Found \(reminderCalendars.count) reminder calendars",
                                 metadata: ["calendars": reminderCalendars.map(\.title)])

        // Create the reminder
        let reminder = EKReminder(eventStore: eventStore)
        reminder.title = title
        reminder.notes = notes.isEmpty ? nil : notes

        // Parse due date if provided
        if !dueDate.isEmpty {
            if let parsedDate = parseDate(dueDate) {
                reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: parsedDate)
            }
        }

        // Use the default calendar for new reminders
        guard let defaultCalendar = eventStore.defaultCalendarForNewReminders() else {
            throw EventKitError.noSourceAvailable
        }
        reminder.calendar = defaultCalendar
        SunnyLogger.shared.debug("EventKit", "Using calendar: \(defaultCalendar.title)")

        // Save the reminder - EventKit will automatically prompt for permissions if needed
        try eventStore.save(reminder, commit: true)
        SunnyLogger.shared.info("EventKit", "Saved reminder",
                                metadata: ["id": reminder.calendarItemIdentifier, "title": title])

        return "Reminder '\(title)' created in '\(defaultCalendar.title)'"
    }

    /// Parse date string in various formats
    func parseDate(_ dateString: String) -> Date? {
        let formatters = [
            "yyyy-MM-dd HH:mm",
            "yyyy-MM-dd",
            "MM/dd/yyyy HH:mm",
            "MM/dd/yyyy",
            "MMM dd, yyyy HH:mm",
            "MMM dd, yyyy",
        ]

        for format in formatters {
            let formatter = DateFormatter()
            formatter.dateFormat = format
            if let date = formatter.date(from: dateString) {
                return date
            }
        }

        return nil
    }
}

/// Errors that can occur when working with EventKit
enum EventKitError: LocalizedError {
    case accessDenied
    case noSourceAvailable
    case invalidDate
    case saveFailed

    var errorDescription: String? {
        switch self {
        case .accessDenied:
            "Access to reminders was denied"
        case .noSourceAvailable:
            "No reminder source available"
        case .invalidDate:
            "Invalid date format"
        case .saveFailed:
            "Failed to save reminder"
        }
    }
}
