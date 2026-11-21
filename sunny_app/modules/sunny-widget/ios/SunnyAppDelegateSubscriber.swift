import ExpoModulesCore
import SunnyLiveActivity
import SunnyWidgetCore
import UIKit

public final class SunnyAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        PushStateReporter.shared.start()
        return true
    }

    public func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard RefreshPush.matches(userInfo) else {
            completionHandler(.noData)
            return
        }
        Task {
            await PushStateReporter.shared.refreshFromPush()
            completionHandler(.newData)
        }
    }
}
