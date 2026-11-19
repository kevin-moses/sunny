import Foundation

public struct WidgetEnvironment: Equatable, Sendable {
    public static let appGroupKey = "SunnyAppGroup"
    public static let keychainGroupKey = "SunnyKeychainGroup"
    static let directoryName = "SunnyWidget"

    public let appGroup: String
    public let keychainGroup: String

    public init(appGroup: String, keychainGroup: String) {
        self.appGroup = appGroup
        self.keychainGroup = keychainGroup
    }

    public static func from(infoDictionary: [String: Any]?) -> WidgetEnvironment? {
        guard
            let appGroup = infoDictionary?[appGroupKey] as? String, !appGroup.isEmpty,
            let keychainGroup = infoDictionary?[keychainGroupKey] as? String, !keychainGroup.isEmpty
        else { return nil }
        return WidgetEnvironment(appGroup: appGroup, keychainGroup: keychainGroup)
    }

    public func storageDirectory() -> URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(Self.directoryName, isDirectory: true)
    }
}

extension WidgetSync {
    private static let sharedTransport = URLSessionTransport()

    public static func live(bundle: Bundle = .main) -> WidgetSync? {
        guard
            let environment = WidgetEnvironment.from(infoDictionary: bundle.infoDictionary),
            let directory = environment.storageDirectory()
        else { return nil }
        return WidgetSync(
            storage: WidgetStorage(directory: directory),
            tokens: KeychainTokenStore(accessGroup: environment.keychainGroup),
            sites: DefaultsSiteStore(suiteName: environment.appGroup),
            transport: sharedTransport
        )
    }
}
