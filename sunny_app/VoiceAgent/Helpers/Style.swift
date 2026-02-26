import SwiftUI

extension CGFloat {
    /// The grid spacing used as a design unit.
    static let grid: Self = 4

    #if os(visionOS)
    /// The corner radius for the platform-specific UI elements.
    static let cornerRadiusPerPlatform: Self = 11.5 * grid
    #else
    /// The corner radius for the platform-specific UI elements.
    static let cornerRadiusPerPlatform: Self = 2 * grid
    #endif

    /// The corner radius for the small UI elements.
    static let cornerRadiusSmall: Self = 2 * grid

    /// The corner radius for the large UI elements.
    static let cornerRadiusLarge: Self = 4 * grid
}

/// Full-width solid button used for primary call-to-action (e.g. connect).
///
/// purpose: Render a prominent tappable button with a solid accent background.
/// @param accentColor: (Color) fill color for the button background; pass theme.accentColor
/// @param fontSize: (CGFloat) label font size in points; pass theme.buttonFontSize
struct ProminentButtonStyle: ButtonStyle {
    var accentColor: Color = .fgAccent
    var fontSize: CGFloat = 19
    var cornerRadius: CGFloat = 12

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: fontSize, weight: .semibold))
            .foregroundStyle(.black)
            .background(accentColor.opacity(configuration.isPressed ? 0.75 : 1))
            .cornerRadius(cornerRadius)
    }
}

/// Circular icon button used in lists and secondary actions.
///
/// purpose: Render a round button with accent fill, disabled-state awareness.
/// @param accentColor: (Color) fill color; defaults to .fgAccent
struct RoundButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) var isEnabled
    var accentColor: Color = .fgAccent

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.white)
            .background(isEnabled ? accentColor.opacity(configuration.isPressed ? 0.75 : 1) : .fg4.opacity(0.4))
            .clipShape(Circle())
    }
}

/// Icon button style used inside the control bar.
///
/// purpose: Render an icon button with optional toggled-on background fill.
/// @param isToggled: (Bool) whether the toggled-on background fill is shown
/// @param foregroundColor: (Color) icon/label tint
/// @param backgroundColor: (Color) fill when isToggled is true
/// @param borderColor: (Color) used for disabled state foreground
struct ControlBarButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) var isEnabled

    var isToggled: Bool = false
    let foregroundColor: Color
    let backgroundColor: Color
    let borderColor: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(isEnabled ? foregroundColor.opacity(configuration.isPressed ? 0.75 : 1) : borderColor)
            .background(
                RoundedRectangle(cornerRadius: .cornerRadiusPerPlatform)
                    .fill(isToggled ? backgroundColor : .clear)
            )
    }
}
