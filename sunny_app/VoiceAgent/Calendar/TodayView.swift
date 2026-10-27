// Calendar/TodayView.swift
//
// Purpose: The senior phone's home screen: the day clock (orientation header, Next up,
// today's tasks and events, the coming week) from get_day_view, with the Talk button at
// the bottom. Refreshes every 30 seconds and when the app comes back to the foreground.
//
// Last modified: 2026-10-27

import SwiftUI

/// Today view for a paired senior phone.
struct TodayView: View {
    @State private var model: DayViewModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// purpose: Create the view for the paired household.
    /// @param householdId: (String) Household the phone is paired with.
    init(householdId: String) {
        _model = State(initialValue: DayViewModel(householdId: householdId))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8 * .grid) {
                if let day = model.day {
                    OrientationHeader(day: day)
                    if let next = day.nextUp {
                        NextUpCard(event: next, when: model.whenText(next))
                    }
                    AgendaList(items: model.agenda, model: model)
                    UpcomingList(events: day.upcoming, model: model)
                } else if let message = model.errorMessage {
                    Text(message).font(.title3)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
                if model.isOffline, model.day != nil {
                    OfflineMark()
                }
            }
            .padding(.horizontal, horizontalSizeClass == .regular ? 24 * .grid : 6 * .grid)
            .padding(.vertical, 6 * .grid)
        }
        .safeAreaInset(edge: .bottom) {
            TalkButton()
                .padding(.horizontal, 6 * .grid)
                .padding(.bottom, 2 * .grid)
        }
        .dayRefresh(model)
    }
}
