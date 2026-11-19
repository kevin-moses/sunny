import Foundation
import Security

public enum StoredToken: Equatable, Sendable {
    case present(String)
    case absent
    case unreadable
}

public protocol TokenStore: Sendable {
    func lookup() -> StoredToken
    func write(_ token: String) throws
    func remove(ifEqualTo expected: String?)
}

extension TokenStore {
    public func read() -> String? {
        guard case .present(let token) = lookup() else { return nil }
        return token
    }
}

public protocol SiteStore: Sendable {
    func read() -> URL?
    func write(_ url: URL)
    func remove()
}

public struct KeychainError: Error, Equatable {
    public let status: OSStatus
}

public struct KeychainTokenStore: TokenStore {
    static let service = "com.kmsunny.sunny.widget"
    static let account = "deviceToken"

    let accessGroup: String

    public init(accessGroup: String) {
        self.accessGroup = accessGroup
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
    }

    public func lookup() -> StoredToken {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        switch SecItemCopyMatching(query as CFDictionary, &item) {
        case errSecSuccess:
            guard let data = item as? Data, let token = String(data: data, encoding: .utf8) else { return .unreadable }
            return .present(token)
        case errSecItemNotFound:
            return .absent
        default:
            return .unreadable
        }
    }

    public func write(_ token: String) throws {
        let data = Data(token.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw KeychainError(status: updated) }
        let added = SecItemAdd(baseQuery.merging(attributes) { _, new in new } as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError(status: added) }
    }

    public func remove(ifEqualTo expected: String?) {
        if let expected, read() != expected { return }
        SecItemDelete(baseQuery as CFDictionary)
    }
}

public struct DefaultsSiteStore: SiteStore {
    static let key = "sunny.widget.siteUrl"

    let suiteName: String

    public init(suiteName: String) {
        self.suiteName = suiteName
    }

    private var defaults: UserDefaults? { UserDefaults(suiteName: suiteName) }

    public func read() -> URL? {
        defaults?.string(forKey: Self.key).flatMap(URL.init(string:))
    }

    public func write(_ url: URL) {
        defaults?.set(url.absoluteString, forKey: Self.key)
    }

    public func remove() {
        defaults?.removeObject(forKey: Self.key)
    }
}
