import EventKit
import Testing
@testable import VoiceAgent

/// Unit tests for EventKitReminderService
///
/// Swift Testing Framework Overview:
/// - Uses @Test instead of XCTest
/// - #expect() for assertions (replaces XCTAssert)
/// - @MainActor for UI-related tests
/// - Async/await support built-in
@MainActor
struct EventKitReminderServiceTests {
    // MARK: - Test Setup

    /// Test that the service can be initialized
    @Test func serviceInitialization() {
        let service = EventKitReminderService()
        #expect(service != nil)
    }

    // MARK: - Date Parsing Tests

    /// Test various date formats that users might speak
    @Test func dateParsing() {
        let service = EventKitReminderService()

        // Test different date formats
        let testDates = [
            "2024-12-25 14:30", // ISO format with time
            "2024-12-25", // ISO format date only
            "12/25/2024 2:30 PM", // US format with time
            "12/25/2024", // US format date only
            "Dec 25, 2024 2:30 PM", // Text format with time
            "Dec 25, 2024", // Text format date only
        ]

        for dateString in testDates {
            // Use reflection to access private method for testing
            let parsedDate = service.parseDate(dateString)
            #expect(parsedDate != nil, "Failed to parse date: \(dateString)")
        }
    }

    /// Test invalid date formats
    @Test func invalidDateParsing() {
        let service = EventKitReminderService()

        let invalidDates = [
            "not a date",
            "32/13/2024", // Invalid day/month
            "2024-13-45", // Invalid month/day
            "tomorrow", // Relative dates (not supported yet)
            "",
        ]

        for dateString in invalidDates {
            let parsedDate = service.parseDate(dateString)
            #expect(parsedDate == nil, "Should not parse invalid date: \(dateString)")
        }
    }

    // MARK: - Reminder Data Tests

    /// Test ReminderData struct encoding/decoding
    @Test func reminderDataCodable() throws {
        // Test encoding
        let reminderData = ReminderData(
            title: "Test Reminder",
            notes: "Test notes",
            due_date: "2024-12-25 14:30"
        )

        let encoder = JSONEncoder()
        let data = try encoder.encode(reminderData)
        #expect(!data.isEmpty)

        // Test decoding
        let decoder = JSONDecoder()
        let decodedData = try decoder.decode(ReminderData.self, from: data)

        #expect(decodedData.title == "Test Reminder")
        #expect(decodedData.notes == "Test notes")
        #expect(decodedData.due_date == "2024-12-25 14:30")
    }

    /// Test ReminderData with optional fields
    @Test func reminderDataOptionalFields() throws {
        let reminderData = ReminderData(
            title: "Simple Reminder",
            notes: nil,
            due_date: nil
        )

        let encoder = JSONEncoder()
        let data = try encoder.encode(reminderData)

        let decoder = JSONDecoder()
        let decodedData = try decoder.decode(ReminderData.self, from: data)

        #expect(decodedData.title == "Simple Reminder")
        #expect(decodedData.notes == nil)
        #expect(decodedData.due_date == nil)
    }

    // MARK: - Error Handling Tests

    /// Test EventKitError cases
    @Test func eventKitErrors() {
        // Test access denied error
        let accessDeniedError = EventKitError.accessDenied
        #expect(accessDeniedError.localizedDescription == "Access to reminders was denied")

        // Test no source available error
        let noSourceError = EventKitError.noSourceAvailable
        #expect(noSourceError.localizedDescription == "No reminder source available")

        // Test invalid date error
        let invalidDateError = EventKitError.invalidDate
        #expect(invalidDateError.localizedDescription == "Invalid date format")

        // Test save failed error
        let saveFailedError = EventKitError.saveFailed
        #expect(saveFailedError.localizedDescription == "Failed to save reminder")
    }
}

// MARK: - Mock EventKit Service for Testing

/// Mock version of EventKitReminderService for testing without EventKit permissions
@MainActor
class MockEventKitReminderService: ObservableObject {
    private var reminders: [MockReminder] = []

    struct MockReminder {
        let title: String
        let notes: String?
        let dueDate: Date?
    }

    func createReminder(title: String, notes: String = "", dueDate: String = "") async throws -> String {
        // Simulate permission check
        try await requestAccess()

        // Create mock reminder
        let reminder = MockReminder(
            title: title,
            notes: notes.isEmpty ? nil : notes,
            dueDate: parseDate(dueDate)
        )

        reminders.append(reminder)
        return "Mock reminder '\(title)' created successfully"
    }

    private func requestAccess() async throws {
        // Simulate permission request - always succeeds in tests
        try await Task.sleep(for: .milliseconds(10))
    }

    private func parseDate(_ dateString: String) -> Date? {
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

    /// Test helper methods
    func getReminderCount() -> Int {
        reminders.count
    }

    func getLastReminder() -> MockReminder? {
        reminders.last
    }
}

// MARK: - Mock Service Tests

@MainActor
struct MockEventKitReminderServiceTests {
    @Test func mockServiceCreation() async throws {
        let service = MockEventKitReminderService()

        // Test creating a simple reminder
        let result = try await service.createReminder(title: "Test Reminder")
        #expect(result.contains("Test Reminder"))
        #expect(service.getReminderCount() == 1)

        // Test creating reminder with notes and date
        let result2 = try await service.createReminder(
            title: "Meeting",
            notes: "Important meeting",
            dueDate: "2024-12-25 14:30"
        )
        #expect(result2.contains("Meeting"))
        #expect(service.getReminderCount() == 2)

        // Verify the last reminder has correct data
        let lastReminder = service.getLastReminder()
        #expect(lastReminder?.title == "Meeting")
        #expect(lastReminder?.notes == "Important meeting")
        #expect(lastReminder?.dueDate != nil)
    }

    @Test func mockServiceDateParsing() async throws {
        let service = MockEventKitReminderService()

        // Test with valid date
        let result = try await service.createReminder(
            title: "Date Test",
            dueDate: "2024-12-25 14:30"
        )
        #expect(result.contains("Date Test"))

        let reminder = service.getLastReminder()
        #expect(reminder?.dueDate != nil)
    }
}

// MARK: - Integration Test Helpers

/// Helper for testing the complete RPC flow
@MainActor
struct ReminderRPCIntegrationTests {
    @Test func rpcDataFlow() throws {
        // Test the data structure that flows from Python agent to iOS app
        let jsonString = """
        {
            "title": "Call Mom",
            "notes": "Remember to call mom about dinner",
            "due_date": "2024-12-25 18:00"
        }
        """

        let data = try #require(jsonString.data(using: .utf8))
        let decoder = JSONDecoder()
        let reminderData = try decoder.decode(ReminderData.self, from: data)

        #expect(reminderData.title == "Call Mom")
        #expect(reminderData.notes == "Remember to call mom about dinner")
        #expect(reminderData.due_date == "2024-12-25 18:00")
    }

    @Test func rpcDataFlowMinimal() throws {
        // Test minimal data (only title required)
        let jsonString = """
        {
            "title": "Simple Reminder"
        }
        """

        let data = try #require(jsonString.data(using: .utf8))
        let decoder = JSONDecoder()
        let reminderData = try decoder.decode(ReminderData.self, from: data)

        #expect(reminderData.title == "Simple Reminder")
        #expect(reminderData.notes == nil)
        #expect(reminderData.due_date == nil)
    }
}
