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

    static func badPressId() -> Exception {
        Exception(name: "BadPressId", description: "The press id is not a UUID")
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

        AsyncFunction("storedSiteUrl") { () -> String? in
            WidgetSync.live()?.storedSiteURL()?.absoluteString
        }

        AsyncFunction("setCredentials") { (token: String, siteUrl: String) async throws in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            guard let url = SiteURL.parse(siteUrl) else { throw BridgeError.unsafeSiteURL() }
            try sync.storeCredentials(token: token, siteURL: url)
            WidgetCenter.shared.reloadAllTimelines()
            await PushStateReporter.shared.startObserving()
        }

        AsyncFunction("clearCredentials") { () async throws in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            try await PushStateReporter.shared.clear(sync)
        }

        AsyncFunction("syncSurfaces") { () async in
            await PushStateReporter.shared.sync(.appSurfaces)
        }

        AsyncFunction("flushPresses") { () async throws -> String in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            return await sync.replayPresses(timeout: WidgetSync.pressTimeout).rawValue
        }

        AsyncFunction("pressLog") { () -> [[String: Any]] in
            (WidgetSync.live()?.pressLog() ?? []).map(PressLogEntry.json)
        }

        AsyncFunction("pressDone") { (instanceId: String, step: Int) async throws -> String in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            return PressLogEntry.status(await sync.storeAppPress(instanceId: instanceId, step: step, in: ActivityKitStore()))
        }

        AsyncFunction("pressUndo") { (pressId: String) throws -> String in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            guard let id = UUID(uuidString: pressId) else { throw BridgeError.badPressId() }
            return sync.storeUndo(ofPress: id).rawValue
        }
    }
}
