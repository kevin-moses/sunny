import Foundation

public enum PressVia: String, Codable, Sendable {
    case widget
}

public struct Press: Codable, Equatable, Sendable {
    public let id: UUID
    public let instanceId: String
    public let step: Int
    public let via: PressVia
    public let pressedAt: Date

    public init(id: UUID = UUID(), instanceId: String, step: Int, via: PressVia, pressedAt: Date) {
        self.id = id
        self.instanceId = instanceId
        self.step = step
        self.via = via
        self.pressedAt = pressedAt
    }

    public var key: PressKey { PressKey(instanceId: instanceId, step: step) }

    public func pressedAgoMs(at now: Date) -> Int {
        max(0, Int((now.timeIntervalSince(pressedAt) * 1000).rounded()))
    }
}

public struct PressedMark: Codable, Equatable, Sendable {
    public let key: PressKey
    public let at: Date
}

public struct PressQueue: Sendable {
    private let pressesDirectory: URL
    private let marksDirectory: URL
    private let stagingDirectory: URL

    public init(directory: URL) {
        pressesDirectory = directory.appendingPathComponent("presses", isDirectory: true)
        marksDirectory = directory.appendingPathComponent("marks", isDirectory: true)
        stagingDirectory = directory.appendingPathComponent("staging", isDirectory: true)
    }

    public func append(_ press: Press) throws {
        let encoder = JSONEncoder()
        try place(encoder.encode(press), named: press.id, in: pressesDirectory)
        try place(encoder.encode(PressedMark(key: press.key, at: press.pressedAt)), named: press.id, in: marksDirectory)
    }

    public func pending() -> [Press] {
        let decoder = JSONDecoder()
        return files(in: pressesDirectory)
            .compactMap { url -> Press? in
                guard let data = try? Data(contentsOf: url) else { return nil }
                guard let press = try? decoder.decode(Press.self, from: data) else {
                    try? FileManager.default.removeItem(at: url)
                    return nil
                }
                return press
            }
            .sorted { ($0.pressedAt, $0.id.uuidString) < ($1.pressedAt, $1.id.uuidString) }
    }

    public func remove(_ id: UUID) {
        try? FileManager.default.removeItem(at: fileURL(for: id, in: pressesDirectory))
    }

    public func pressed() -> Set<PressKey> {
        Set(marks().map(\.mark.key))
    }

    public func reconcile(withTimelineFetchedFrom fetchStartedAt: Date) {
        let waiting = Set(pending().map(\.key))
        for (url, mark) in marks() where !waiting.contains(mark.key) && mark.at < fetchStartedAt {
            try? FileManager.default.removeItem(at: url)
        }
    }

    @discardableResult
    public func removeAll() throws -> Bool {
        var removed = false
        for directory in [pressesDirectory, marksDirectory, stagingDirectory]
        where FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
            removed = true
        }
        return removed
    }

    private func marks() -> [(url: URL, mark: PressedMark)] {
        let decoder = JSONDecoder()
        return files(in: marksDirectory).compactMap { url in
            guard let data = try? Data(contentsOf: url) else { return nil }
            guard let mark = try? decoder.decode(PressedMark.self, from: data) else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            return (url, mark)
        }
    }

    private func files(in directory: URL) -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.map { directory.appendingPathComponent($0) }
    }

    private func fileURL(for id: UUID, in directory: URL) -> URL {
        directory.appendingPathComponent("\(id.uuidString).json")
    }

    private func place(_ data: Data, named id: UUID, in directory: URL) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let staged = stagingDirectory.appendingPathComponent("\(UUID().uuidString).json")
        try data.write(to: staged, options: [.withoutOverwriting, .completeFileProtectionUntilFirstUserAuthentication])
        do {
            try manager.moveItem(at: staged, to: fileURL(for: id, in: directory))
        } catch {
            try? manager.removeItem(at: staged)
            throw error
        }
    }
}

public enum ConfirmStatus: Equatable, Sendable {
    case confirmed
    case advanced
    case rejected(reason: String?)
    case unrecognized(String)
}

public enum ConfirmOutcome: Equatable, Sendable {
    case answered(ConfirmStatus)
    case unreadable
    case unauthorized
    case rateLimited(retryAfter: TimeInterval?)
    case failed
}

public enum ReplayDecision: Equatable, Sendable {
    case drop
    case keepAndStop
    case keepAndStopUnauthorized
}

public enum PressReplay {
    public static func decision(for outcome: ConfirmOutcome) -> ReplayDecision {
        switch outcome {
        case .answered(.confirmed), .answered(.advanced), .answered(.rejected), .answered(.unrecognized):
            return .drop
        case .unreadable:
            return .drop
        case .unauthorized:
            return .keepAndStopUnauthorized
        case .rateLimited, .failed:
            return .keepAndStop
        }
    }
}
