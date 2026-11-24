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

    func isCollectible(at now: Date) -> Bool {
        isFinished && now.timeIntervalSince(press.pressedAt) > PressQueue.recordLifetime
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

struct UnsentPress: Equatable {
    let press: Press
    let sendsPress: Bool
    let undo: PressUndo?
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
        try write(press, to: .press, of: press.id)
    }

    public func append(_ undo: PressUndo) throws {
        do {
            try write(undo, to: .undo, of: undo.pressId)
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
        try? write(answer, to: file, of: send.pressId)
    }

    public func records() -> [PressRecord] {
        files()
            .compactMap { id, found in UUID(uuidString: id).flatMap { record($0, from: found) } }
            .sorted { Self.inPressOrder($0.press, $1.press) }
    }

    public func record(_ id: UUID) -> PressRecord? {
        record(id, from: Set(LogFile.allCases.filter { exists($0, of: id) }))
    }

    public func answer(of pressId: UUID) -> PressAnswer? {
        read(.answer, of: pressId)
    }

    public func unsent() -> [QueuedSend] {
        let pending = files().compactMap { id, found -> UnsentPress? in
            let sendsPress = !found.contains(.answer)
            let sendsUndo = found.contains(.undo) && !found.contains(.undoAnswer)
            guard found.contains(.press), sendsPress || sendsUndo, let uuid = UUID(uuidString: id) else { return nil }
            guard let press: Press = read(.press, of: uuid) else { return nil }
            return UnsentPress(press: press, sendsPress: sendsPress, undo: sendsUndo ? read(.undo, of: uuid) : nil)
        }
        return Self.unsent(in: pending.sorted { Self.inPressOrder($0.press, $1.press) })
    }

    static func unsent(in pending: [UnsentPress]) -> [QueuedSend] {
        var sends: [(at: Date, order: Int, send: QueuedSend)] = []
        for (order, item) in pending.enumerated() {
            if item.sendsPress {
                sends.append((item.press.pressedAt, 2 * order, .confirm(item.press)))
            }
            if let undo = item.undo {
                sends.append((max(undo.undoneAt, item.press.pressedAt), 2 * order + 1, .undo(undo)))
            }
        }
        return sends.sorted { ($0.at, $0.order) < ($1.at, $1.order) }.map(\.send)
    }

    public func hidden(onTimelineFetchedFrom fetchStartedAt: Date?) -> Set<PressKey> {
        Set(records().filter { $0.hidesItsCard(onTimelineFetchedFrom: fetchStartedAt) }.map(\.press.key))
    }

    public func collect(at now: Date) {
        for (id, found) in files() {
            guard let uuid = UUID(uuidString: id) else { continue }
            if found.contains(.press) {
                guard let record = record(uuid, from: found), record.isCollectible(at: now) else { continue }
            }
            for file in found { remove(file, of: uuid) }
        }
        sweepStaging(at: now)
    }

    private func sweepStaging(at now: Date) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: stagingDirectory.path)) ?? []
        for name in names {
            let staged = stagingDirectory.appendingPathComponent(name)
            let attributes = try? FileManager.default.attributesOfItem(atPath: staged.path)
            guard let modified = attributes?[.modificationDate] as? Date else { continue }
            if now.timeIntervalSince(modified) > Self.recordLifetime { try? FileManager.default.removeItem(at: staged) }
        }
    }

    public func removeAll() throws {
        guard FileManager.default.fileExists(atPath: logDirectory.path) else { return }
        try FileManager.default.removeItem(at: logDirectory)
    }

    private static func inPressOrder(_ first: Press, _ second: Press) -> Bool {
        (first.pressedAt, first.id.uuidString) < (second.pressedAt, second.id.uuidString)
    }

    private func record(_ id: UUID, from found: Set<LogFile>) -> PressRecord? {
        guard found.contains(.press), let press: Press = read(.press, of: id) else { return nil }
        return PressRecord(
            press: press,
            answer: found.contains(.answer) ? read(.answer, of: id) : nil,
            undo: found.contains(.undo) ? read(.undo, of: id) : nil,
            undoAnswer: found.contains(.undoAnswer) ? read(.undoAnswer, of: id) : nil
        )
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

    private func write<Value: Encodable>(_ value: Value, to file: LogFile, of id: UUID) throws {
        let staged = try stage(JSONEncoder().encode(value))
        do {
            try FileManager.default.moveItem(at: staged, to: url(file, of: id))
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
