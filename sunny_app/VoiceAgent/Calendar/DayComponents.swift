// Calendar/DayComponents.swift
//
// Purpose: The building blocks of the day clock, shared by the phone's Today view and
// the home display: the orientation header ("Monday evening", date below, no minute
// clock), the Next up card, today's agenda and the coming week. Sizes scale with a
// `scale` factor so the display can use much larger type than the phone. Calm, high
// contrast, no motion.
//
// Last modified: 2026-10-27

import SwiftUI

/// "Monday evening" in large type with the date below.
struct OrientationHeader: View {
    let day: DayViewData
    var scale: CGFloat = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 4 * scale) {
            Text(day.header)
                .font(.system(size: 40 * scale, weight: .bold, design: .rounded))
            Text(day.dateLabel)
                .font(.system(size: 24 * scale, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The next event and who or where it involves.
struct NextUpCard: View {
    let event: EventOccurrence
    let when: String
    var scale: CGFloat = 1
    @Environment(SunnyTheme.self) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6 * scale) {
            SectionTitle(text: "Next up", scale: scale)
            Text(event.label)
                .font(.system(size: 30 * scale, weight: .bold, design: .rounded))
                .lineLimit(2)
                .minimumScaleFactor(0.6)
            Text(details)
                .font(.system(size: 22 * scale, weight: .medium, design: .rounded))
        }
        .padding(18 * scale)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 18 * scale))
        .accessibilityElement(children: .combine)
    }

    private var details: String {
        var parts = [when]
        if let visitor = event.visitorName { parts.append("with \(visitor)") }
        if let place = event.place { parts.append("at \(place)") }
        return parts.joined(separator: " ")
    }
}

/// Today's tasks and events in time order; finished tasks are checked off, the due one is
/// highlighted, and events (nothing to confirm) carry a calendar icon.
struct AgendaList: View {
    let items: [AgendaItem]
    let model: DayViewModel
    var scale: CGFloat = 1
    @Environment(SunnyTheme.self) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 10 * scale) {
            SectionTitle(text: "Today", scale: scale)
            if items.isEmpty {
                Text("Nothing else today.")
                    .font(.system(size: 22 * scale, design: .rounded))
                    .foregroundStyle(.secondary)
            }
            ForEach(items) { item in
                row(item)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func row(_ item: AgendaItem) -> some View {
        switch item {
        case let .task(task):
            line(
                icon: task.isDone ? "checkmark.circle.fill" : "circle",
                time: model.displayTime(task.scheduledTime),
                text: task.displayLabel,
                done: task.isDone,
                highlighted: task.isDue
            )
        case let .event(event):
            line(icon: "calendar", time: model.displayTime(event.startTime), text: event.label, done: false, highlighted: false)
        }
    }

    private func line(icon: String, time: String, text: String, done: Bool, highlighted: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12 * scale) {
            Image(systemName: icon)
                .foregroundStyle(done ? .green : .secondary)
            Text(time)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 96 * scale, alignment: .leading)
            Text(text)
                .strikethrough(done)
                .fontWeight(highlighted ? .bold : .regular)
        }
        .font(.system(size: 22 * scale, design: .rounded))
        .padding(.vertical, 6 * scale)
        .padding(.horizontal, highlighted ? 10 * scale : 0)
        .background(highlighted ? theme.accentColor.opacity(0.25) : .clear, in: RoundedRectangle(cornerRadius: 10 * scale))
        .accessibilityElement(children: .combine)
        .accessibilityValue(done ? "Done" : highlighted ? "Due now" : "")
    }
}

/// The coming week's events.
struct UpcomingList: View {
    let events: [EventOccurrence]
    let model: DayViewModel
    var scale: CGFloat = 1

    var body: some View {
        if !events.isEmpty {
            VStack(alignment: .leading, spacing: 8 * scale) {
                SectionTitle(text: "Coming up", scale: scale)
                ForEach(events) { event in
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(event.label).fontWeight(.medium)
                            Spacer()
                            Text(model.whenText(event)).foregroundStyle(.secondary)
                        }
                        VStack(alignment: .leading, spacing: 2 * scale) {
                            Text(event.label).fontWeight(.medium)
                            Text(model.whenText(event)).foregroundStyle(.secondary)
                        }
                    }
                    .font(.system(size: 20 * scale, design: .rounded))
                    .accessibilityElement(children: .combine)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A small uppercase heading for a section of the day clock.
struct SectionTitle: View {
    let text: LocalizedStringKey
    var scale: CGFloat = 1

    var body: some View {
        Text(text)
            .font(.system(size: 16 * scale, weight: .semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
    }
}

/// A small mark shown when the latest refresh failed and the screen shows cached data.
struct OfflineMark: View {
    var body: some View {
        Label("Not connected", systemImage: "wifi.slash")
            .font(.footnote)
            .foregroundStyle(.secondary)
    }
}
