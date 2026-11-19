import Foundation

public struct CachedTimeline: Sendable {
    public let timeline: DeviceTimeline
    public let etag: String?
}

private struct CacheEnvelope: Codable {
    let etag: String?
    let body: Data
}

public struct WidgetStorage: Sendable {
    private let directory: URL
    public let presses: PressQueue

    public init(directory: URL) {
        self.directory = directory
        presses = PressQueue(directory: directory)
    }

    private var cacheURL: URL { directory.appendingPathComponent("timeline.json") }
    private var lockURL: URL { directory.appendingPathComponent("credentials.lock") }
    private var widgetPushURL: URL { directory.appendingPathComponent("widgetPush.json") }

    public func loadCache() -> CachedTimeline? {
        guard
            let data = try? Data(contentsOf: cacheURL),
            let envelope = try? JSONDecoder().decode(CacheEnvelope.self, from: data),
            let timeline = try? DeviceTimeline.decode(envelope.body)
        else { return nil }
        return CachedTimeline(timeline: timeline, etag: envelope.etag)
    }

    public func saveCache(body: Data, etag: String?) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(CacheEnvelope(etag: etag, body: body))
        try data.write(to: cacheURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func loadWidgetPush() -> WidgetPushReport? {
        guard let data = try? Data(contentsOf: widgetPushURL) else { return nil }
        return try? JSONDecoder().decode(WidgetPushReport.self, from: data)
    }

    public func saveWidgetPush(_ report: WidgetPushReport) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(report)
        try data.write(to: widgetPushURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    @discardableResult
    public func removeAll() throws -> Bool {
        var removed = try presses.removeAll()
        if FileManager.default.fileExists(atPath: cacheURL.path) {
            try FileManager.default.removeItem(at: cacheURL)
            removed = true
        }
        return removed
    }

    public func withCredentialsLock<T>(_ body: () throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw CocoaError(.fileLocking) }
        defer { flock(descriptor, LOCK_UN) }
        return try body()
    }
}
