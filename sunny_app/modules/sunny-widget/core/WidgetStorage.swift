import Foundation

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

    public func loadCache() -> DeviceTimeline? {
        guard let body = try? Data(contentsOf: cacheURL) else { return nil }
        return try? DeviceTimeline.decode(body)
    }

    public func saveCache(body: Data) throws {
        try write(body, to: cacheURL)
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
