// VoiceAgentTests/DayViewModelTests.swift
//
// Purpose: Unit tests for the day clock model: decoding the get_day_view payload (extra
// server keys ignored), relative day wording, local time formatting, and agenda order.
// First draft generated with the local Qwen model (ask_qwen.sh), reviewed and corrected.

import Foundation
@testable import sunny
import Testing

@MainActor
struct DayViewModelTests {
    private func decode(_ json: String) throws -> DayViewData {
        try SunnyBackend.decoder.decode(DayViewData.self, from: Data(json.utf8))
    }

    // MARK: - 1. Decoding a realistic payload

    @Test func decodeRealisticGetDayView() throws {
        let json = """
        {
          "local_date": "2026-10-26",
          "date_label": "October 26",
          "header": "Monday evening",
          "timezone": "America/New_York",
          "weekday": "Monday",
          "senior_preferred_name": "Margaret",
          "tasks": [
            {
              "instance_id": "t-001",
              "display_label": "Take blood pressure medication",
              "scheduled_time": "08:00:00",
              "state": "due"
            },
            {
              "instance_id": "t-002",
              "display_label": "Evening walk",
              "scheduled_time": "18:00:00",
              "state": "upcoming"
            }
          ],
          "events_today": [
            {
              "event_id": "e-100",
              "label": "Cardiology appointment",
              "local_date": "2026-10-26",
              "start_time": "14:00:00",
              "place": "Downtown Medical Center, Suite 410",
              "visitor_name": null,
              "starts_at": "2026-10-26T14:00:00Z",
              "title": "Cardiology – Dr. Patel"
            },
            {
              "event_id": "e-101",
              "label": "Lunch with Susan",
              "local_date": "2026-10-26",
              "start_time": "12:00:00",
              "place": null,
              "visitor_name": "Susan Chen"
            }
          ],
          "next_up": {
            "event_id": "e-100",
            "label": "Cardiology appointment",
            "local_date": "2026-10-26",
            "start_time": "14:00:00",
            "place": "Downtown Medical Center, Suite 410",
            "visitor_name": null
          },
          "upcoming": [
            {
              "event_id": "e-200",
              "label": "Dentist",
              "local_date": "2026-10-29",
              "start_time": "09:30:00",
              "place": "Smile Clinic",
              "visitor_name": null
            }
          ]
        }
        """

        let data = try decode(json)

        #expect(data.localDate == "2026-10-26")
        #expect(data.dateLabel == "October 26")
        #expect(data.header == "Monday evening")

        // Tasks
        #expect(data.tasks.count == 2)
        #expect(data.tasks[0].instanceId == "t-001")
        #expect(data.tasks[0].displayLabel == "Take blood pressure medication")
        #expect(data.tasks[0].scheduledTime == "08:00:00")
        #expect(data.tasks[0].state == "due")
        #expect(data.tasks[0].isDue)
        #expect(!data.tasks[0].isDone)
        #expect(data.tasks[1].instanceId == "t-002")
        #expect(data.tasks[1].state == "upcoming")
        #expect(!data.tasks[1].isDue)
        #expect(!data.tasks[1].isDone)

        // Events – extra keys (starts_at, title) are ignored; place may be null
        #expect(data.eventsToday.count == 2)
        #expect(data.eventsToday[0].eventId == "e-100")
        #expect(data.eventsToday[0].label == "Cardiology appointment")
        #expect(data.eventsToday[0].localDate == "2026-10-26")
        #expect(data.eventsToday[0].startTime == "14:00:00")
        #expect(data.eventsToday[0].place == "Downtown Medical Center, Suite 410")
        #expect(data.eventsToday[0].visitorName == nil)
        #expect(data.eventsToday[1].place == nil)
        #expect(data.eventsToday[1].visitorName == "Susan Chen")

        // Next up
        #expect(data.nextUp?.eventId == "e-100")
        #expect(data.nextUp?.startTime == "14:00:00")

        // Upcoming
        #expect(data.upcoming.count == 1)
        #expect(data.upcoming[0].localDate == "2026-10-29")
    }

    // MARK: - 2. whenText

    @Test func whenTextToday() throws {
        let json = """
        {
          "local_date": "2026-10-26",
          "date_label": "October 26",
          "header": "Monday evening",
          "tasks": [],
          "events_today": [
            {
              "event_id": "e1",
              "label": "Cardiology appointment",
              "local_date": "2026-10-26",
              "start_time": "14:00:00",
              "place": "Clinic",
              "visitor_name": null
            }
          ],
          "next_up": null,
          "upcoming": []
        }
        """
        let data = try decode(json)
        let model = DayViewModel(householdId: "h", day: data)
        let event = data.eventsToday[0]
        #expect(model.whenText(event) == "Today at 2:00 PM")
    }

    @Test func whenTextTomorrow() throws {
        let json = """
        {
          "local_date": "2026-10-26",
          "date_label": "October 26",
          "header": "Monday evening",
          "tasks": [],
          "events_today": [],
          "next_up": null,
          "upcoming": [
            {
              "event_id": "e1",
              "label": "Doctor visit",
              "local_date": "2026-10-27",
              "start_time": "09:00:00",
              "place": "Clinic",
              "visitor_name": null
            }
          ]
        }
        """
        let data = try decode(json)
        let model = DayViewModel(householdId: "h", day: data)
        let event = data.upcoming[0]
        #expect(model.whenText(event) == "Tomorrow at 9:00 AM")
    }

    @Test func whenTextLaterInWeek() throws {
        let json = """
        {
          "local_date": "2026-10-26",
          "date_label": "October 26",
          "header": "Monday evening",
          "tasks": [],
          "events_today": [],
          "next_up": null,
          "upcoming": [
            {
              "event_id": "e1",
              "label": "Family dinner",
              "local_date": "2026-10-29",
              "start_time": "15:00:00",
              "place": null,
              "visitor_name": null
            }
          ]
        }
        """
        let data = try decode(json)
        let model = DayViewModel(householdId: "h", day: data)
        let event = data.upcoming[0]
        #expect(model.whenText(event) == "Thursday at 3:00 PM")
    }

    // MARK: - 3. displayTime

    @Test func displayTimeFormats() {
        let model = DayViewModel(householdId: "h", day: nil)
        #expect(model.displayTime("08:00:00") == "8:00 AM")
        #expect(model.displayTime("00:30:00") == "12:30 AM")
        #expect(model.displayTime("not-a-valid-time") == "not-a-valid-time")
    }

    // MARK: - 4. Agenda ordering

    @Test func agendaOrdersTasksAndEventsByLocalTime() throws {
        let json = """
        {
          "local_date": "2026-10-26",
          "date_label": "October 26",
          "header": "Monday evening",
          "tasks": [
            {
              "instance_id": "t-evening",
              "display_label": "Evening walk",
              "scheduled_time": "18:00:00",
              "state": "due"
            },
            {
              "instance_id": "t-morning",
              "display_label": "Morning medication",
              "scheduled_time": "07:30:00",
              "state": "confirmed"
            }
          ],
          "events_today": [
            {
              "event_id": "e-lunch",
              "label": "Lunch with Susan",
              "local_date": "2026-10-26",
              "start_time": "12:00:00",
              "place": null,
              "visitor_name": "Susan Chen"
            },
            {
              "event_id": "e-cardio",
              "label": "Cardiology",
              "local_date": "2026-10-26",
              "start_time": "14:00:00",
              "place": "Downtown Medical Center",
              "visitor_name": null
            }
          ],
          "next_up": null,
          "upcoming": []
        }
        """
        let data = try decode(json)
        let model = DayViewModel(householdId: "h", day: data)
        let agenda = model.agenda

        #expect(agenda.count == 4)
        // 07:30 task → 12:00 event → 14:00 event → 18:00 task
        #expect(agenda[0].id == "task-t-morning")
        #expect(agenda[1].id == "event-e-lunch-2026-10-26")
        #expect(agenda[2].id == "event-e-cardio-2026-10-26")
        #expect(agenda[3].id == "task-t-evening")

        // Verify the enum cases
        guard case let .task(first) = agenda[0], case let .event(second) = agenda[1] else {
            Issue.record("Expected a task, then an event")
            return
        }
        #expect(first.instanceId == "t-morning")
        #expect(second.eventId == "e-lunch")
    }

    // MARK: - 5. isOffline

    @Test func isOfflineFalseInitially() throws {
        let json = """
        {
          "local_date": "2026-10-26",
          "date_label": "October 26",
          "header": "Monday evening",
          "tasks": [],
          "events_today": [],
          "next_up": null,
          "upcoming": []
        }
        """
        let data = try decode(json)
        let model = DayViewModel(householdId: "h", day: data)
        #expect(model.isOffline == false)
    }
}
