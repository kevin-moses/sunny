import Foundation

public enum ClockFormat {
    private static let formatters = NSCache<NSString, DateFormatter>()

    public static func time(_ date: Date, in timeZone: TimeZone, locale: Locale) -> String {
        formatter(timeZone: timeZone, locale: locale).string(from: date)
    }

    private static func formatter(timeZone: TimeZone, locale: Locale) -> DateFormatter {
        let key = "\(timeZone.identifier) \(locale.identifier) \(locale.hourCycle)" as NSString
        if let cached = formatters.object(forKey: key) { return cached }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        formatters.setObject(formatter, forKey: key)
        return formatter
    }
}
