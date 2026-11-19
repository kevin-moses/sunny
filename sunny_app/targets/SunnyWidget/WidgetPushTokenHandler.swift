import SunnyWidgetCore
import WidgetKit

@available(iOS 26.0, *)
struct WidgetPushTokenHandler: WidgetPushHandler {
    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        guard let sync = WidgetSync.live() else { return }
        let report = sync.storeWidgetPush(token: pushInfo.token.hexString)
        Task { _ = await sync.reportPushState(report) }
    }
}
