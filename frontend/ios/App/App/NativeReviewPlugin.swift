import UIKit
import StoreKit
import Capacitor

/// Asks StoreKit for Apple's rating sheet (ADR 0036).
///
/// The web decides when (frontend/src/lib/reviewPromptState.ts: after care
/// was marked done a few times, never on a first launch or a setup screen,
/// once per version and 120 days apart) and calls `requestReview`. This
/// plugin only hands the request to StoreKit on the app's active scene.
/// Apple decides whether the sheet appears: at most three times in 365 days,
/// never in TestFlight, and never for someone who turned off In-App Ratings
/// and Reviews in Settings.
///
/// It carries no words and offers nothing: the sheet is Apple's own, the same
/// for a person who loves the app and one who does not (App Review
/// Guideline 5.6.1).
///
/// It lives in the app target rather than an npm package, like PrintPlugin:
/// it is one StoreKit call, and MainViewController registers it.
@objc(NativeReviewPlugin)
public class NativeReviewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeReviewPlugin"
    public let jsName = "NativeReview"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise)
    ]

    /// Resolves `{ requested }`: true when StoreKit was handed the request,
    /// false when the app had no scene in the foreground to show it on (a
    /// notification action handled in the background, say). The web counts
    /// only `true` as an ask.
    @objc func requestReview(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let scene = self?.bridge?.webView?.window?.windowScene,
                  scene.activationState == .foregroundActive else {
                call.resolve(["requested": false])
                return
            }
            if #available(iOS 16.0, *) {
                AppStore.requestReview(in: scene)
            } else {
                SKStoreReviewController.requestReview(in: scene)
            }
            call.resolve(["requested": true])
        }
    }
}
