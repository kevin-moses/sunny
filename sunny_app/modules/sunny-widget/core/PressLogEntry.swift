import Foundation

public enum PressLogEntry {
    public static func json(_ record: PressRecord) -> [String: Any] {
        var entry: [String: Any] = [
            "pressId": record.press.id.uuidString,
            "instanceId": record.press.instanceId,
            "step": record.press.step,
            "pressedAt": epochMs(record.press.pressedAt),
        ]
        if let answer = record.answer { entry["answer"] = json(answer) }
        if let undo = record.undo {
            var undone: [String: Any] = ["undoneAt": epochMs(undo.undoneAt)]
            if let answer = record.undoAnswer { undone["answer"] = json(answer) }
            entry["undo"] = undone
        }
        return entry
    }

    public static func status(_ stored: StoredPress) -> String {
        switch stored {
        case .stored: return "stored"
        case .sentUnstored(.clean): return "sent"
        case .sentUnstored: return "notSaved"
        case .noCredentials: return "noCredentials"
        }
    }

    public static func status(_ stored: StoredUndo) -> String {
        switch stored {
        case .stored: return "stored"
        case .notStored: return "notSaved"
        case .noCredentials: return "noCredentials"
        }
    }

    private static func json(_ answer: PressAnswer) -> [String: Any] {
        var json: [String: Any] = ["applied": answer.applied]
        if let count = answer.answeredPresses { json["answeredPresses"] = count }
        return json
    }
}
