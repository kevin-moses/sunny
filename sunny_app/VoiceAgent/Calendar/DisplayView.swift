// Calendar/DisplayView.swift
//
// Purpose: The home display, stubbed on an iPad until the e-ink hardware exists: a calm,
// glanceable day clock in very large type (orientation header, Next up, today's list,
// the coming week) and the fixed going-out strip at the bottom. No buttons besides what
// the SPEC asks for later (Done, Talk); nothing to configure on the device. Keeps the
// screen awake and refreshes every 30 seconds. Lays out in two columns in landscape and
// one in portrait.
//
// Last modified: 2026-10-27

import SwiftUI
import UIKit

/// Full-screen day clock for a paired home display.
struct DisplayView: View {
    @State private var model: DayViewModel

    /// purpose: Create the display for the paired household.
    /// @param householdId: (String) Household the display is paired with.
    init(householdId: String) {
        _model = State(initialValue: DayViewModel(householdId: householdId))
    }

    var body: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: 32) {
                if let day = model.day {
                    OrientationHeader(day: day, scale: 2)
                    // Landscape: Next up and the week beside today's list. Portrait: one column.
                    if geometry.size.width > geometry.size.height {
                        HStack(alignment: .top, spacing: 48) {
                            VStack(alignment: .leading, spacing: 32) {
                                nextUp(day)
                                upcoming(day)
                            }
                            .frame(maxWidth: .infinity)
                            agenda().frame(maxWidth: .infinity)
                        }
                    } else {
                        nextUp(day)
                        agenda()
                        upcoming(day)
                    }
                    Spacer(minLength: 0)
                } else {
                    Spacer()
                    Text(model.errorMessage ?? "Loading...")
                        .font(.system(size: 36, design: .rounded))
                        .frame(maxWidth: .infinity)
                    Spacer()
                }
                goingOutStrip()
            }
            .padding(48)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .overlay(alignment: .topTrailing) {
            if model.isOffline, model.day != nil {
                OfflineMark().padding(24)
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .dayRefresh(model)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    @ViewBuilder
    private func nextUp(_ day: DayViewData) -> some View {
        if let next = day.nextUp {
            NextUpCard(event: next, when: model.whenText(next), scale: 1.5)
        }
    }

    private func upcoming(_ day: DayViewData) -> some View {
        UpcomingList(events: Array(day.upcoming.prefix(4)), model: model, scale: 1.4)
    }

    private func agenda() -> some View {
        AgendaList(items: model.agenda, model: model, scale: 1.5)
    }

    /// The fixed reminder at the bottom of the display; always visible, nothing to press.
    private func goingOutStrip() -> some View {
        Text("Going out?  Wallet · Keys · Glasses · Phone")
            .font(.system(size: 30, weight: .semibold, design: .rounded))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 20)
            .background(.black.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
            .accessibilityLabel("Going out? Take your wallet, keys, glasses and phone.")
    }
}
