// Theme/SunnyColors.swift
//
// Defines Sunny's brand color palette and a Color extension for hex initialization.
// This is the canonical source for all Sunny brand colors.
//
// The fixed background color (#FAE6CC) is applied app-wide and is not user-selectable.
// The five warm accent colors are used for interactive elements, highlights, and
// the audio visualizer. Text is always BLACK for maximum senior-readable contrast.

import SwiftUI

/// Fixed app background color — not user-selectable.
enum SunnyColors {
    static let background = Color(hex: "#FAE6CC")
}

/// The five warm accent colors in Sunny's design palette.
/// Each entry is (name, color) for use in DevSettingsView color swatches.
enum SunnyPalette {
    static let all: [(name: String, color: Color)] = [
        ("Orange",      Color(hex: "#FA8539")),
        ("Golden",      Color(hex: "#FABF39")),
        ("Amber",       Color(hex: "#FAA739")),
        ("Deep Orange", Color(hex: "#FA6339")),
        ("Yellow",      Color(hex: "#FADA54")),
    ]
}

extension Color {
    /// Initializes a Color from a CSS-style hex string, e.g. "#E63700" or "E63700".
    ///
    /// purpose: Convert a 6-digit hex color string to a SwiftUI Color.
    /// @param hex: (String) hex color string with or without a leading "#"
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xFF) / 255.0
        let g = Double((int >>  8) & 0xFF) / 255.0
        let b = Double((int >>  0) & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}
