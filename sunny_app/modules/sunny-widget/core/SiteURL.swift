import Foundation

public enum SiteURL {
    public static func parse(_ text: String) -> URL? {
        guard
            let url = URL(string: text),
            let scheme = url.scheme?.lowercased(),
            let host = url.host?.lowercased(),
            !host.isEmpty
        else { return nil }
        switch scheme {
        case "https":
            return url
        case "http":
            return isLoopback(host) ? url : nil
        default:
            return nil
        }
    }

    static func isLoopback(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4, octets.allSatisfy({ UInt8($0) != nil }) else { return false }
        return octets.first == "127"
    }
}
