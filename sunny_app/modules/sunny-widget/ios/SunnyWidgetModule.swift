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

        Function("unsentPresses") { () -> [[String: Any]] in
            (WidgetSync.live()?.unsentPresses() ?? []).map { press in
                [
                    "id": press.id.uuidString,
                    "instanceId": press.instanceId,
                    "step": press.step,
                    "pressedAt": press.pressedAt.timeIntervalSince1970 * 1000,
                ]
            }
        }

        AsyncFunction("markPressed") { (pressId: String, instanceId: String, step: Int, pressedAt: Double) async throws in
            guard let sync = WidgetSync.live() else { throw BridgeError.notConfigured() }
            guard let id = UUID(uuidString: pressId) else { throw BridgeError.badPressId() }
            let at = Date(timeIntervalSince1970: pressedAt / 1000)
            try await PushStateReporter.shared.markAppPress(sync, id: id, instanceId: instanceId, step: step, pressedAt: at)
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
