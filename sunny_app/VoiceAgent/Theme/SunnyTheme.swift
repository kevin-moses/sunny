import SwiftUI

/// Holds all runtime-adjustable design parameters for the Sunny UI.
/// Read in any view with: @Environment(SunnyTheme.self) private var theme
@Observable
final class SunnyTheme {
    // MARK: - Accent Color

    /// Index into SunnyPalette.all that determines the current accent color.
    /// Default: 0 (Orange Red, #E63700)
    var accentColorIndex: Int {
        didSet { UserDefaults.standard.set(accentColorIndex, forKey: Keys.accentColorIndex) }
    }

    // MARK: - Typography

    /// Body text size in points — used for transcripts, labels, tips.
    /// Default: 17pt. Slider range: 14–24pt.
    var bodyFontSize: CGFloat {
        didSet { UserDefaults.standard.set(Double(bodyFontSize), forKey: Keys.bodyFontSize) }
    }

    /// Button label text size in points — used for the connect/action buttons.
    /// Default: 19pt. Slider range: 15–28pt.
    var buttonFontSize: CGFloat {
        didSet { UserDefaults.standard.set(Double(buttonFontSize), forKey: Keys.buttonFontSize) }
    }

    // MARK: - Geometry

    /// Corner radius applied to cards, bubbles, and primary buttons.
    /// Default: 12pt. Slider range: 4–32pt.
    var cornerRadius: CGFloat {
        didSet { UserDefaults.standard.set(Double(cornerRadius), forKey: Keys.cornerRadius) }
    }

    // MARK: - Derived

    /// The currently selected accent color from SunnyPalette.
    var accentColor: Color {
        SunnyPalette.all[accentColorIndex].color
    }

    /// The human-readable name of the currently selected accent color.
    var accentColorName: String {
        SunnyPalette.all[accentColorIndex].name
    }

    /// Fixed app background color — not user-selectable.
    var backgroundColor: Color {
        SunnyColors.background
    }

    // MARK: - Init

    /// Loads previously saved values from UserDefaults, falling back to defaults.
    init() {
        let ud = UserDefaults.standard

        let savedIndex = ud.integer(forKey: Keys.accentColorIndex)
        accentColorIndex = (0 ..< SunnyPalette.all.count).contains(savedIndex) ? savedIndex : 0

        let rawBody = ud.double(forKey: Keys.bodyFontSize)
        bodyFontSize = rawBody > 0 ? CGFloat(rawBody) : 17

        let rawButton = ud.double(forKey: Keys.buttonFontSize)
        buttonFontSize = rawButton > 0 ? CGFloat(rawButton) : 19

        let rawRadius = ud.double(forKey: Keys.cornerRadius)
        cornerRadius = rawRadius > 0 ? CGFloat(rawRadius) : 12
    }

    // MARK: - Reset

    /// Resets all theme values to their factory defaults and clears UserDefaults.
    ///
    /// purpose: Restore the theme to baseline after experimenting with sliders.
    func resetToDefaults() {
        accentColorIndex = 0
        bodyFontSize = 17
        buttonFontSize = 19
        cornerRadius = 12
    }

    // MARK: - UserDefaults Keys

    private enum Keys {
        static let accentColorIndex = "sunnyTheme.accentColorIndex"
        static let bodyFontSize = "sunnyTheme.bodyFontSize"
        static let buttonFontSize = "sunnyTheme.buttonFontSize"
        static let cornerRadius = "sunnyTheme.cornerRadius"
    }
}
