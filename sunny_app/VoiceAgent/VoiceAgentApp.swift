import LiveKit
import SwiftUI

@main
struct VoiceAgentApp: App {
    /// Root view model managing connection state and agent features.
    private let viewModel = AppViewModel()

    /// Shared theme object — drives all adjustable UI parameters via DevSettingsView.
    @State private var theme = SunnyTheme()

    var body: some Scene {
        WindowGroup {
            AppView()
                .environment(viewModel)
                .environment(theme)
        }
        #if os(macOS)
        .defaultSize(width: 900, height: 900)
        #endif
        #if os(visionOS)
        .windowStyle(.plain)
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1500, height: 500)
        #endif
    }
}

/// A set of flags that define the features supported by the agent.
/// Enable them based on your agent capabilities.
struct AgentFeatures: OptionSet {
    let rawValue: Int

    static let voice = Self(rawValue: 1 << 0)
    static let text = Self(rawValue: 1 << 1)
    static let video = Self(rawValue: 1 << 2)

    static let current: Self = [.voice, .text]
}
