import UIKit
import WebKit
import Capacitor

/// Capacitor's bridge view controller, plus the plugins that live in this app
/// target instead of an npm package. Main.storyboard names this class, so it
/// is the one iOS creates at launch.
class MainViewController: CAPBridgeViewController {
    /// Kept for the life of the controller: dropping them stops the updates.
    private var backSwipeObservations: [NSKeyValueObservation] = []

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrintPlugin())
        observeBackSwipe()
    }

    /// The iOS edge swipe back (and forward), over the app's own history.
    ///
    /// WKWebView turns the gesture off by default, so without this a swipe
    /// from the left edge did nothing, the clearest "this is a website" tell
    /// on an iPhone. Every route change in the app is a history entry
    /// (React Router's pushState), so the system gesture, with WebKit's own
    /// page-peel animation, walks the same history the in-page back links do.
    ///
    /// It is switched on only while the page behind is one the swipe should
    /// reach (`BackSwipePolicy`), re-decided whenever the URL or the history
    /// changes. That is what keeps it from going back out of the app, into a
    /// sign-in or setup screen that would only redirect, or onto nothing at
    /// all on the first screen.
    private func observeBackSwipe() {
        guard let webView = webView else { return }
        backSwipeObservations = [
            webView.observe(\.url, options: [.initial, .new]) { [weak self] _, _ in
                self?.updateBackSwipe()
            },
            webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
                self?.updateBackSwipe()
            },
        ]
    }

    private func updateBackSwipe() {
        guard let webView = webView else { return }
        webView.allowsBackForwardNavigationGestures = BackSwipePolicy.allows(
            from: webView.url,
            to: webView.backForwardList.backItem?.url
        )
    }
}

/// Whether the edge swipe may take the app from `current` back to `back`.
///
/// - Nothing behind (the first screen): no swipe, so it is a no-op rather
///   than a peel onto a blank page.
/// - Anything that is not this app's own origin (`capacitor://localhost`):
///   no swipe. The shell never leaves it today; this makes sure a swipe never
///   can.
/// - `/`, which only ever redirects (to sign-in or the dashboard): no swipe.
/// - Sign-in and first-run setup on one side, the signed-in app on the other:
///   no swipe. After signing in, the page behind is a sign-in or setup screen
///   that would redirect straight back (or show sign-in to someone who is
///   signed in); after signing out, the page behind is an app screen that
///   would bounce to sign-in. Swiping between two sign-in screens (sign-in
///   and create account), or between two app screens, is allowed.
///
/// The paths are routes in frontend/src/App.tsx;
/// frontend/tests/unit/config/nativeBackSwipe.test.ts fails if one is renamed.
enum BackSwipePolicy {
    static let signInAndSetupPaths: Set<String> = [
        "/login",
        "/register",
        "/confirm-email",
        "/forgot-password",
        "/reset-password",
        "/onboarding",
        "/welcome",
    ]

    static func allows(from current: URL?, to back: URL?) -> Bool {
        guard let current = current, let back = back else { return false }
        guard back.scheme == current.scheme, back.host == current.host else { return false }
        let backPath = normalized(back.path)
        if backPath == "/" { return false }
        return signInAndSetupPaths.contains(backPath)
            == signInAndSetupPaths.contains(normalized(current.path))
    }

    private static func normalized(_ path: String) -> String {
        if path.isEmpty { return "/" }
        if path.count > 1 && path.hasSuffix("/") { return String(path.dropLast()) }
        return path
    }
}
