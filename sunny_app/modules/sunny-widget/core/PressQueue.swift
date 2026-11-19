import Foundation

public enum PressVia: String, Codable, Sendable {
    case widget
    case liveActivity = "live_activity"
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

    public init(key: PressKey, at: Date) {
        self.key = key
        self.at = at
    }

    func isSettled(answeredAt: Date?, byTimelineFetchedFrom fetchStartedAt: Date) -> Bool {
        if let answeredAt { return answeredAt < fetchStartedAt }
        return fetchStartedAt.timeIntervalSince(at) > PressQueue.markLifetime
    }
}

struct PressAnswer: Codable, Equatable, Sendable {
    let at: Date
}

public struct PressQueue: Sendable {
    public static let markLifetime: TimeInterval = 48 * 60 * 60

    private let pressesDirectory: URL
    private let marksDirectory: URL
    private let answersDirectory: URL
    private let stagingDirectory: URL

    public init(directory: URL) {
        pressesDirectory = directory.appendingPathComponent("presses", isDirectory: true)
        marksDirectory = directory.appendingPathComponent("marks", isDirectory: true)
        answersDirectory = directory.appendingPathComponent("answers", isDirectory: true)
        stagingDirectory = directory.appendingPathComponent("staging", isDirectory: true)
    }

    public func append(_ press: Press) throws {
        let encoder = JSONEncoder()
        try write(
            encoder.encode(PressedMark(key: press.key, at: press.pressedAt)),
            to: fileURL(for: press.id, in: marksDirectory),
            overwriting: false
        )
        do {
            try write(encoder.encode(press), to: fileURL(for: press.id, in: pressesDirectory), overwriting: false)
        } catch {
            try? FileManager.default.removeItem(at: fileURL(for: press.id, in: marksDirectory))
            throw error
        }
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

    public func answered(_ id: UUID, at answeredAt: Date) {
        try? write(JSONEncoder().encode(PressAnswer(at: answeredAt)), to: fileURL(for: id, in: answersDirectory), overwriting: true)
        try? FileManager.default.removeItem(at: fileURL(for: id, in: pressesDirectory))
    }

    public func mark(_ id: UUID, key: PressKey, at pressedAt: Date) throws {
        try write(
            JSONEncoder().encode(PressedMark(key: key, at: pressedAt)),
            to: fileURL(for: id, in: marksDirectory),
            overwriting: true
        )
    }

    public func removeMark(_ id: UUID) {
        removeMark(named: fileURL(for: id, in: marksDirectory).lastPathComponent)
    }

    public func pressed() -> Set<PressKey> {
        Set(marks().map(\.mark.key))
    }

    public func reconcile(withTimelineFetchedFrom fetchStartedAt: Date) {
        var marked: Set<String> = []
        for (url, mark) in marks() {
            let name = url.lastPathComponent
            if mark.isSettled(answeredAt: answer(named: name)?.at, byTimelineFetchedFrom: fetchStartedAt) {
                removeMark(named: name)
            } else {
                marked.insert(name)
            }
        }
        for url in files(in: answersDirectory) where !marked.contains(url.lastPathComponent) {
            let answeredAt = answer(named: url.lastPathComponent)?.at ?? .distantPast
            if fetchStartedAt.timeIntervalSince(answeredAt) > Self.markLifetime {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    public func removeAll() throws {
        for directory in [pressesDirectory, marksDirectory, answersDirectory, stagingDirectory]
        where FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
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

    private func answer(named name: String) -> PressAnswer? {
        let url = answersDirectory.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(PressAnswer.self, from: data)
    }

    private func removeMark(named name: String) {
        try? FileManager.default.removeItem(at: marksDirectory.appendingPathComponent(name))
        try? FileManager.default.removeItem(at: answersDirectory.appendingPathComponent(name))
    }

    private func files(in directory: URL) -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.map { directory.appendingPathComponent($0) }
    }

    private func fileURL(for id: UUID, in directory: URL) -> URL {
        directory.appendingPathComponent("\(id.uuidString).json")
    }

    private func write(_ data: Data, to destination: URL, overwriting: Bool) throws {
        let staged = try stage(data)
        do {
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if overwriting {
                guard rename(staged.path, destination.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            } else {
                try FileManager.default.moveItem(at: staged, to: destination)
            }
        } catch {
            try? FileManager.default.removeItem(at: staged)
            throw error
        }
    }

    private func stage(_ data: Data) throws -> URL {
        try FileManager.default.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
        let staged = stagingDirectory.appendingPathComponent("\(UUID().uuidString).json")
        try data.write(to: staged, options: [.withoutOverwriting, .completeFileProtectionUntilFirstUserAuthentication])
        return staged
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
    case serverError(status: Int)
    case failed
}

public enum ReplayDecision: Equatable, Sendable {
    case drop
    case keepAndHoldTask
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
        case .serverError:
            return .keepAndHoldTask
        case .rateLimited, .failed:
            return .keepAndStop
        }
    }
}
