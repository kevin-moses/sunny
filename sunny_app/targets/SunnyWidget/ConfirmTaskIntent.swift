import AppIntents
import SunnyWidgetCore

struct ConfirmTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Done"
    static let description = IntentDescription("Marks the task shown in the Sunny widget as done.")
    static let isDiscoverable = false

    @Parameter(title: "Task")
    var instanceId: String

    @Parameter(title: "Step")
    var step: Int

    init() {}

    init(instanceId: String, step: Int) {
        self.instanceId = instanceId
        self.step = step
    }

    func perform() async throws -> some IntentResult {
        _ = await WidgetSync.live()?.pressDone(instanceId: instanceId, step: step, via: .widget)
        return .result()
    }
}
