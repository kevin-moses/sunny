import ExpoModulesCore
import SunnyLiveActivity
import SunnyWidgetCore
import WidgetKit

enum BridgeError {
    static func notConfigured() -> Exception {
        Exception(
            name: "WidgetNotConfigured",
            description: "The app is missing its widget app group or keychain group"
        )
    }

    static func unsafeSiteURL() -> Exception {
        Exception(
            name: "UnsafeSiteURL",
            description: "The site URL must be https, or http on this device only"
        )
    }
}

public final class SunnyWidgetModule: Module {
    public func definition() -> ModuleDefinition {
        Name("SunnyWidget")

        Function("storedSiteUrl") { () -> String? in
            WidgetSync.live()?.storedSiteURL()?.absoluteString
        }

        AsyncFunction("setCredentials") { (token: String, siteUrl: String) throws in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            guard let url = SiteURL.parse(siteUrl) else { throw BridgeError.unsafeSiteURL() }
            try sync.storeCredentials(token: token, siteURL: url)
            WidgetCenter.shared.reloadAllTimelines()
        }

        AsyncFunction("clearCredentials") { () async throws -> Bool in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            return try await PushStateReporter.shared.clear(sync).get()
        }

        AsyncFunction("syncSurfaces") { () async in
            await PushStateReporter.shared.sync()
        }

        AsyncFunction("flushPresses") { () async throws -> String in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            return await sync.replayPresses(timeout: WidgetSync.pressTimeout).rawValue
        }
    }
}
