import AppIntents
internal import SunnyLiveActivity

struct ConfirmActivityIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Done"
    static let description = IntentDescription("Marks the task shown on the Lock Screen as done.")
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
        await PushStateReporter.shared.confirm(instanceId: instanceId, step: step)
        return .result()
    }
}
