// Start/PairingView.swift
//
// Purpose: First-run screen for a senior device: enter the 8-character join code a
// caregiver created in the caregiver app (or with supabase/scripts/caregiver.ts codes).
// The code decides whether this device becomes the senior's phone or the home display.
// Usually a caregiver does this for the senior during setup.
//
// Last modified: 2026-10-27

import SwiftUI

/// Join-code entry that pairs this device with a household.
struct PairingView: View {
    /// Called with the pairing once the code is accepted.
    let onPaired: (PairedDevice) -> Void

    @Environment(SunnyTheme.self) private var theme
    @State private var code = ""
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 6 * .grid) {
            Spacer()
            Text("Connect to your family")
                .font(.system(size: 32, weight: .bold, design: .rounded))
                .multilineTextAlignment(.center)
            Text("Enter the code from the Sunny caregiver app.")
                .font(.system(size: 20, design: .rounded))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            TextField("Code", text: $code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .focused($focused)
                .padding(4 * .grid)
                .background(.white.opacity(0.6), in: RoundedRectangle(cornerRadius: theme.cornerRadius))
                .frame(maxWidth: 420)
                .accessibilityLabel("Join code")
            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 18))
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            AsyncButton(action: pair) {
                Text("Connect").frame(maxWidth: 420, minHeight: 60)
            } busyLabel: {
                Spinner().frame(maxWidth: 420, minHeight: 60)
            }
            .buttonStyle(
                ProminentButtonStyle(
                    accentColor: theme.accentColor,
                    fontSize: theme.buttonFontSize,
                    cornerRadius: theme.cornerRadius
                )
            )
            .disabled(code.count(where: { $0.isLetter || $0.isNumber }) != 8)
            Spacer()
        }
        .padding(8 * .grid)
        .onAppear { focused = true }
    }

    /// purpose: Redeem the code and report the pairing; show the server's message on failure.
    private func pair() async {
        errorMessage = nil
        do {
            try await onPaired(SunnyBackend.shared.pair(code: code))
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
