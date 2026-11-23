import Foundation

public enum PressVia: String, Codable, Sendable {
    case widget
    case liveActivity = "live_activity"
    case phoneApp = "phone_app"
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
}

public struct PressUndo: Codable, Equatable, Sendable {
    public let pressId: UUID
    public let instanceId: String
    public let undoneAt: Date

    public init(pressId: UUID, instanceId: String, undoneAt: Date) {
        self.pressId = pressId
        self.instanceId = instanceId
        self.undoneAt = undoneAt
    }
}

public struct PressAnswer: Codable, Equatable, Sendable {
    public let at: Date
    public let applied: Bool
    public let answeredPresses: Int?

    public init(at: Date, applied: Bool, answeredPresses: Int?) {
        self.at = at
        self.applied = applied
        self.answeredPresses = answeredPresses
    }

    func joined(with earlier: PressAnswer?) -> PressAnswer {
        guard let earlier else { return self }
        let counts = [earlier.answeredPresses, answeredPresses].compactMap { $0 }
        return PressAnswer(at: min(earlier.at, at), applied: earlier.applied || applied, answeredPresses: counts.max())
    }
}

public struct PressRecord: Equatable, Sendable {
    public let press: Press
    public let answer: PressAnswer?
    public let undo: PressUndo?
    public let undoAnswer: PressAnswer?

    public init(press: Press, answer: PressAnswer? = nil, undo: PressUndo? = nil, undoAnswer: PressAnswer? = nil) {
        self.press = press
        self.answer = answer
        self.undo = undo
        self.undoAnswer = undoAnswer
    }

    var isFinished: Bool {
        answer != nil && (undo == nil || undoAnswer != nil)
    }

    func hidesItsCard(onTimelineFetchedFrom fetchStartedAt: Date?) -> Bool {
        guard undo == nil else { return false }
        guard let answer, let fetchStartedAt else { return true }
        return answer.at >= fetchStartedAt
    }
}

public enum QueuedSend: Equatable, Sendable {
    case confirm(Press)
    case undo(PressUndo)

    public var pressId: UUID {
        switch self {
        case .confirm(let press): return press.id
        case .undo(let undo): return undo.pressId
        }
    }

    public var instanceId: String {
        switch self {
        case .confirm(let press): return press.instanceId
        case .undo(let undo): return undo.instanceId
        }
    }

    public func agoMs(at now: Date) -> Int {
        let tappedAt: Date
        switch self {
        case .confirm(let press): tappedAt = press.pressedAt
        case .undo(let undo): tappedAt = undo.undoneAt
        }
        return max(0, Int((now.timeIntervalSince(tappedAt) * 1000).rounded()))
    }
}

private enum LogFile: String, CaseIterable {
    case press
    case answer
    case undo
    case undoAnswer

    func name(_ id: UUID) -> String { "\(id.uuidString).\(rawValue).json" }

    static func parse(_ name: String) -> (id: String, file: LogFile)? {
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2] == "json", let file = LogFile(rawValue: String(parts[1])) else { return nil }
        return (String(parts[0]), file)
    }
}

public struct PressQueue: Sendable {
    public static let recordLifetime: TimeInterval = 48 * 60 * 60

    private let logDirectory: URL
    private let stagingDirectory: URL

    public init(directory: URL) {
        logDirectory = directory.appendingPathComponent("pressLog", isDirectory: true)
        stagingDirectory = logDirectory.appendingPathComponent("staging", isDirectory: true)
    }

    public func append(_ press: Press) throws {
        try write(press, to: .press, of: press.id, overwriting: false)
    }

    public func append(_ undo: PressUndo) throws {
        do {
            try write(undo, to: .undo, of: undo.pressId, overwriting: false)
        } catch {
            guard exists(.undo, of: undo.pressId) else { throw error }
        }
    }

    public func answered(_ send: QueuedSend, with answer: PressAnswer) {
        let file: LogFile
        switch send {
        case .confirm: file = .answer
        case .undo: file = .undoAnswer
        }
        try? write(answer.joined(with: read(file, of: send.pressId)), to: file, of: send.pressId, overwriting: true)
    }

    public func records() -> [PressRecord] {
        let listed = files()
        return listed.keys
            .compactMap { id -> PressRecord? in
                guard let found = listed[id], found.contains(.press), let uuid = UUID(uuidString: id) else { return nil }
                guard let press: Press = read(.press, of: uuid) else { return nil }
                return PressRecord(
                    press: press,
                    answer: found.contains(.answer) ? read(.answer, of: uuid) : nil,
                    undo: found.contains(.undo) ? read(.undo, of: uuid) : nil,
                    undoAnswer: found.contains(.undoAnswer) ? read(.undoAnswer, of: uuid) : nil
                )
            }
            .sorted { ($0.press.pressedAt, $0.press.id.uuidString) < ($1.press.pressedAt, $1.press.id.uuidString) }
    }

    public func record(_ id: UUID) -> PressRecord? {
        records().first { $0.press.id == id }
    }

    public func unsent() -> [QueuedSend] {
        Self.unsent(in: records())
    }

    static func unsent(in records: [PressRecord]) -> [QueuedSend] {
        var sends: [(at: Date, order: Int, send: QueuedSend)] = []
        for (order, record) in records.enumerated() {
            if record.answer == nil {
                sends.append((record.press.pressedAt, 2 * order, .confirm(record.press)))
            }
            if let undo = record.undo, record.undoAnswer == nil {
                sends.append((max(undo.undoneAt, record.press.pressedAt), 2 * order + 1, .undo(undo)))
            }
        }
        return sends.sorted { ($0.at, $0.order) < ($1.at, $1.order) }.map(\.send)
    }

    public func hidden(onTimelineFetchedFrom fetchStartedAt: Date?) -> Set<PressKey> {
        Set(records().filter { $0.hidesItsCard(onTimelineFetchedFrom: fetchStartedAt) }.map(\.press.key))
    }

    public func collect(at now: Date) {
        let finished = records().filter { $0.isFinished && now.timeIntervalSince($0.press.pressedAt) > Self.recordLifetime }
        for record in finished {
            for file in LogFile.allCases { remove(file, of: record.press.id) }
        }
        for (id, found) in files() where !found.contains(.press) {
            guard let uuid = UUID(uuidString: id) else { continue }
            for file in found { remove(file, of: uuid) }
        }
    }

    public func removeAll() throws {
        guard FileManager.default.fileExists(atPath: logDirectory.path) else { return }
        try FileManager.default.removeItem(at: logDirectory)
    }

    private func files() -> [String: Set<LogFile>] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: logDirectory.path)) ?? []
        var listed: [String: Set<LogFile>] = [:]
        for name in names {
            guard let (id, file) = LogFile.parse(name) else { continue }
            listed[id, default: []].insert(file)
        }
        return listed
    }

    private func url(_ file: LogFile, of id: UUID) -> URL {
        logDirectory.appendingPathComponent(file.name(id))
    }

    private func exists(_ file: LogFile, of id: UUID) -> Bool {
        FileManager.default.fileExists(atPath: url(file, of: id).path)
    }

    private func remove(_ file: LogFile, of id: UUID) {
        try? FileManager.default.removeItem(at: url(file, of: id))
    }

    private func read<Value: Decodable>(_ file: LogFile, of id: UUID) -> Value? {
        let source = url(file, of: id)
        guard let data = try? Data(contentsOf: source) else { return nil }
        guard let value = try? JSONDecoder().decode(Value.self, from: data) else {
            try? FileManager.default.removeItem(at: source)
            return nil
        }
        return value
    }

    private func write<Value: Encodable>(_ value: Value, to file: LogFile, of id: UUID, overwriting: Bool) throws {
        let destination = url(file, of: id)
        let staged = try stage(JSONEncoder().encode(value))
        do {
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

public enum AnswerStatus: Equatable, Sendable {
    case confirmed
    case advanced
    case undone
    case rejected(reason: String?)
    case tooLate
    case unrecognized(String)

    public var applied: Bool {
        switch self {
        case .confirmed, .advanced, .undone: return true
        case .rejected, .tooLate, .unrecognized: return false
        }
    }
}

public struct ServerAnswer: Equatable, Sendable {
    public let status: AnswerStatus
    public let answeredPresses: Int?

    public init(status: AnswerStatus, answeredPresses: Int? = nil) {
        self.status = status
        self.answeredPresses = answeredPresses
    }
}

public enum SendOutcome: Equatable, Sendable {
    case answered(ServerAnswer)
    case unreadable
    case unauthorized
    case rateLimited(retryAfter: TimeInterval?)
    case serverError(status: Int)
    case failed

    var answer: ServerAnswer? {
        guard case .answered(let answer) = self else { return nil }
        return answer
    }
}

public enum ReplayDecision: Equatable, Sendable {
    case drop
    case keepAndHoldTask
    case keepAndStop
    case keepAndStopUnauthorized
}

public enum PressReplay {
    public static func decision(for outcome: SendOutcome) -> ReplayDecision {
        switch outcome {
        case .answered, .unreadable:
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
