import Foundation

public enum LineBreaking {
    public static func greedy(_ text: String, maxLines: Int, fits: (String) -> Bool) -> [String] {
        let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty, maxLines > 0 else { return [] }
        var lines: [String] = []
        var current = ""
        for word in words {
            let candidate = current.isEmpty ? word : "\(current) \(word)"
            if current.isEmpty || fits(candidate) {
                current = candidate
            } else {
                lines.append(current)
                current = word
            }
        }
        lines.append(current)
        guard lines.count > maxLines else { return lines }
        let kept = lines.prefix(maxLines - 1)
        let rest = lines.dropFirst(maxLines - 1).joined(separator: " ")
        return Array(kept) + [rest]
    }
}
