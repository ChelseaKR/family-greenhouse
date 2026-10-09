import UIKit
import UserNotifications
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        registerReminderNotificationCategory()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    // Forward APNs registration results to the Capacitor PushNotifications
    // plugin (required by @capacitor/push-notifications — without these the
    // JS 'registration' event never fires). Needs the Push Notifications
    // capability enabled on the App target; see docs/mobile.md.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    // MARK: - Reminder notification actions

    /// The category a reminder about exactly one task arrives with
    /// (`aps.category`, set by backend/src/services/apnsNotifier.ts). The
    /// string must match `APNS_REMINDER_CATEGORY` there; a mismatch shows a
    /// notification with no buttons and no error anywhere.
    static let reminderCategoryIdentifier = "FG_TASK_REMINDER"

    /// Register the Done and Snooze buttons a single-task reminder shows on a
    /// long-press (or a pull-down). Done at every launch: iOS keeps the set
    /// per app install and this is the only place it is defined.
    ///
    /// Neither action carries `.foreground`, so choosing one does not open
    /// the app: iOS starts it in the background for the request, the
    /// Capacitor plugin reports it as `pushNotificationActionPerformed` with
    /// `actionId` "done" or "snooze" and retains that event until the web
    /// layer's listener is attached (frontend/src/services/nativePush.ts),
    /// which posts it to the task's own endpoint with the stored session. An
    /// app that was not running acts at its next launch at the latest, and
    /// the request is a no-op on the server once the occurrence has moved on.
    ///
    /// Registering categories asks for no permission and shows nothing.
    private func registerReminderNotificationCategory() {
        let titles = reminderActionTitles()
        let done = UNNotificationAction(identifier: "done", title: titles.done, options: [])
        let snooze = UNNotificationAction(identifier: "snooze", title: titles.snooze, options: [])
        let category = UNNotificationCategory(
            identifier: AppDelegate.reminderCategoryIdentifier,
            actions: [done, snooze],
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// The button titles, in the device's language. The app bundle carries no
    /// string catalogs (the web layer owns every other string), so the first
    /// preferred language decides, and the words are the ones
    /// `reminderActionCopy` in backend/src/services/reminderCopy.ts uses for
    /// web push, so the two platforms read the same.
    private func reminderActionTitles() -> (done: String, snooze: String) {
        let language = Locale.preferredLanguages.first?.lowercased() ?? "en"
        if language.hasPrefix("es") {
            return (done: "Hecho", snooze: "Posponer hasta mañana")
        }
        return (done: "Done", snooze: "Snooze until tomorrow")
    }

}
