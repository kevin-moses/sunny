import Foundation

public struct CachedTimeline: Sendable {
    public let timeline: DeviceTimeline
    public let etag: String?
}

public struct WidgetStorage: Sendable {
    private let directory: URL
    public let presses: PressQueue

    public init(directory: URL) {
        self.directory = directory
        presses = PressQueue(directory: directory)
    }

    private var cacheURL: URL { directory.appendingPathComponent("timeline.json") }
    private var etagURL: URL { directory.appendingPathComponent("timeline.etag") }
    private var lockURL: URL { directory.appendingPathComponent("credentials.lock") }
    private var widgetPushURL: URL { directory.appendingPathComponent("widgetPush.json") }

    public func loadCache() -> CachedTimeline? {
        guard let body = try? Data(contentsOf: cacheURL), let timeline = try? DeviceTimeline.decode(body) else {
            return nil
        }
        let etag = (try? Data(contentsOf: etagURL)).flatMap { String(data: $0, encoding: .utf8) }
        return CachedTimeline(timeline: timeline, etag: etag)
    }

    public func saveCache(body: Data, etag: String?) throws {
        try removeIfPresent(etagURL)
        try write(body, to: cacheURL)
        if let etag { try write(Data(etag.utf8), to: etagURL) }
    }

    public func loadWidgetPush() -> WidgetPushReport? {
        guard let data = try? Data(contentsOf: widgetPushURL) else { return nil }
        return try? JSONDecoder().decode(WidgetPushReport.self, from: data)
    }

    public func saveWidgetPush(_ report: WidgetPushReport) throws {
        try write(JSONEncoder().encode(report), to: widgetPushURL)
    }

    public func removeAll() throws {
        try presses.removeAll()
        try removeIfPresent(etagURL)
        try removeIfPresent(cacheURL)
    }

    private func removeIfPresent(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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
