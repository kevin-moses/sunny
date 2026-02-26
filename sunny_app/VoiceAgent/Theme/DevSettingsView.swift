import SwiftUI

/// Form-based sheet exposing live sliders and pickers for all SunnyTheme properties.
struct DevSettingsView: View {
    /// All slider/picker changes update the live UI immediately.
    @Environment(SunnyTheme.self) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        TabView {
            NavigationStack {
                Form {
                    accentColorSection()
                    typographySection()
                    geometrySection()
                    resetSection()
                }
                .navigationTitle("Dev Settings")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                            .accessibilityLabel("Close developer settings")
                    }
                }
            }
            .tabItem {
                Label("Settings", systemImage: "slider.horizontal.3")
            }

            NavigationStack {
                ConversationListView()
            }
            .tabItem {
                Label("Logs", systemImage: "bubble.left.and.bubble.right")
            }
        }
    }

    // MARK: - Sections

    /// Color swatch picker for selecting from SunnyPalette.
    @ViewBuilder
    private func accentColorSection() -> some View {
        @Bindable var theme = theme
        Section {
            ForEach(SunnyPalette.all.indices, id: \.self) { i in
                let entry = SunnyPalette.all[i]
                HStack(spacing: 12) {
                    Circle()
                        .fill(entry.color)
                        .frame(width: 28, height: 28)
                        .overlay(Circle().stroke(Color.primary.opacity(0.15), lineWidth: 1))
                    Text(entry.name)
                        .font(.system(size: 16))
                    Spacer()
                    if theme.accentColorIndex == i {
                        Image(systemName: "checkmark")
                            .foregroundStyle(entry.color)
                            .fontWeight(.semibold)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { theme.accentColorIndex = i }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(entry.name)\(theme.accentColorIndex == i ? ", selected" : "")")
                .accessibilityAddTraits(theme.accentColorIndex == i ? [.isButton, .isSelected] : .isButton)
            }
        } header: {
            Text("Accent Color")
        } footer: {
            HStack(spacing: 8) {
                Text("Current:")
                    .foregroundStyle(.secondary)
                RoundedRectangle(cornerRadius: 4)
                    .fill(theme.accentColor)
                    .frame(width: 60, height: 20)
                Text(theme.accentColorName)
                    .fontWeight(.medium)
                    .foregroundStyle(theme.accentColor)
            }
            .font(.system(size: 13))
            .padding(.top, 4)
        }
    }

    /// Sliders for body and button font sizes with a live preview.
    @ViewBuilder
    private func typographySection() -> some View {
        @Bindable var theme = theme
        Section("Typography") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Body Text")
                    Spacer()
                    Text("\(Int(theme.bodyFontSize))pt")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Slider(value: $theme.bodyFontSize, in: 14 ... 24, step: 1)
                    .tint(theme.accentColor)
                Text("Preview: Tap the button below to talk.")
                    .font(.system(size: theme.bodyFontSize))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 4)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Button Text")
                    Spacer()
                    Text("\(Int(theme.buttonFontSize))pt")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Slider(value: $theme.buttonFontSize, in: 15 ... 28, step: 1)
                    .tint(theme.accentColor)
                RoundedRectangle(cornerRadius: theme.cornerRadius)
                    .fill(theme.accentColor)
                    .frame(height: 52)
                    .overlay(
                        Text("Talk to Sunny")
                            .font(.system(size: theme.buttonFontSize, weight: .semibold))
                            .foregroundStyle(.black)
                    )
            }
            .padding(.vertical, 4)
        }
    }

    /// Slider for button/card corner radius with a side-by-side preview.
    @ViewBuilder
    private func geometrySection() -> some View {
        @Bindable var theme = theme
        Section("Geometry") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Corner Radius")
                    Spacer()
                    Text("\(Int(theme.cornerRadius))pt")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Slider(value: $theme.cornerRadius, in: 4 ... 32, step: 2)
                    .tint(theme.accentColor)
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: theme.cornerRadius)
                        .fill(theme.accentColor.opacity(0.15))
                        .frame(height: 44)
                        .overlay(
                            RoundedRectangle(cornerRadius: theme.cornerRadius)
                                .stroke(theme.accentColor, lineWidth: 1.5)
                        )
                    RoundedRectangle(cornerRadius: theme.cornerRadius)
                        .fill(theme.accentColor)
                        .frame(height: 44)
                }
            }
            .padding(.vertical, 4)
        }
    }

    /// Destructive reset button to restore all factory defaults.
    private func resetSection() -> some View {
        Section {
            Button("Reset to Defaults", role: .destructive) {
                theme.resetToDefaults()
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

#Preview {
    DevSettingsView()
        .environment(SunnyTheme())
}
