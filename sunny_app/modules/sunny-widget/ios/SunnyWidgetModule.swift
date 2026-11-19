import ExpoModulesCore
import SunnyWidgetCore
import WidgetKit

final class WidgetNotConfiguredException: Exception, @unchecked Sendable {
    override var reason: String { "The app is missing its widget app group or keychain group" }
}

final class InvalidSiteURLException: Exception, @unchecked Sendable {
    override var reason: String { "The site URL is not a valid URL" }
}

public final class SunnyWidgetModule: Module {
    public func definition() -> ModuleDefinition {
        Name("SunnyWidget")

        Function("storedSiteUrl") { () -> String? in
            WidgetSync.live()?.storedSiteURL()?.absoluteString
        }

        AsyncFunction("setCredentials") { (token: String, siteUrl: String) throws in
            guard let sync = WidgetSync.live() else { throw WidgetNotConfiguredException() }
            guard let url = URL(string: siteUrl), url.scheme != nil else { throw InvalidSiteURLException() }
            try sync.storeCredentials(token: token, siteURL: url)
            WidgetCenter.shared.reloadAllTimelines()
        }

        AsyncFunction("clearCredentials") { () throws -> Bool in
            guard let sync = WidgetSync.live() else { throw WidgetNotConfiguredException() }
            let removed = try sync.clear()
            if removed { WidgetCenter.shared.reloadAllTimelines() }
            return removed
        }

        Function("reloadTimelines") {
            WidgetCenter.shared.reloadAllTimelines()
        }

        AsyncFunction("flushPresses") { () async throws -> String in
            guard let sync = WidgetSync.live() else { throw WidgetNotConfiguredException() }
            return await sync.replayPresses(timeout: WidgetSync.pressTimeout).rawValue
        }
    }
}
