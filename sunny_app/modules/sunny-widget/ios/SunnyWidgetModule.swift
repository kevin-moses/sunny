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

        Function("storedSiteUrl") { () -> String? in
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

        Function("unsentPresses") { () -> [[String: Any]] in
            (WidgetSync.live()?.unsentPresses() ?? []).map { press in
                [
                    "pressId": press.id.uuidString,
                    "instanceId": press.instanceId,
                    "step": press.step,
                    "pressedAt": epochMs(press.pressedAt),
                ]
            }
        }

        AsyncFunction("markPressed") { (pressId: String, instanceId: String, step: Int, pressedAt: Double) async throws in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            guard let id = UUID(uuidString: pressId) else { throw BridgeError.badPressId() }
            try await PushStateReporter.shared.markAppPress(
                sync,
                id: id,
                instanceId: instanceId,
                step: step,
                pressedAt: date(fromEpochMs: pressedAt)
            )
        }

        AsyncFunction("answerPress") { (pressId: String) throws in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            guard let id = UUID(uuidString: pressId) else { throw BridgeError.badPressId() }
            sync.answerAppPress(id: id)
        }

        AsyncFunction("withdrawPress") { (pressId: String) throws in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            guard let id = UUID(uuidString: pressId) else { throw BridgeError.badPressId() }
            sync.withdrawAppPress(id: id)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
