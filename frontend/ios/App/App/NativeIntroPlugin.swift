import UIKit
import SwiftUI
import Capacitor

/// The signed-out intro, in SwiftUI, over the web's sign-in screen.
///
/// Web -> native (answered):
/// - `present({ token, start, pages, skip, next, pagePosition, appName,
///   tagline, create?, signIn })` shows the intro full screen and resolves
///   `{ choice }`: `"create"` or `"signIn"` for the door that was tapped, or
///   null for no choice (the web closed it, another intro replaced it,
///   VoiceOver's escape on the last page). The shapes are written down once,
///   in frontend/src/config/nativeIntro.ts, and
///   frontend/tests/unit/config/nativeIntro.test.ts holds this file to them.
/// - `dismiss({ token })`: the web left the sign-in screen first; the intro
///   goes away and answers no choice.
///
/// It only presents and reports. Signing in and creating an account are the
/// web's own screens, with the same requests as the website.
///
/// The web asks for it only when `Capacitor.PluginHeaders` lists this plugin
/// with both methods, so an app built without it (and Android) keeps the
/// web sign-in screen exactly as before. MainViewController registers it.
@objc(NativeIntroPlugin)
public class NativeIntroPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeIntroPlugin"
    public let jsName = "NativeIntro"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise)
    ]

    private var shown: (token: String, session: IntroSession, controller: UIViewController)?

    @objc func present(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("present needs a token", "INVALID")
            return
        }
        let parsed = IntroRequest.parse(call.options as? [String: Any] ?? [:])
        guard var request = parsed.request else {
            call.reject(parsed.error ?? "invalid intro", "INVALID")
            return
        }
        #if DEBUG
        // Simulator screenshots only (IntroScreenshotHook): the last page
        // alone, as after a sign-out, without having to answer the story.
        if ProcessInfo.processInfo.environment["FG_INTRO_START"] == "final" {
            request = request.starting(.final)
        }
        #endif
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let host = self.bridge?.viewController else {
                call.resolve(["choice": NSNull()])
                return
            }
            // One at a time: a second request replaces the first, which
            // answers no choice.
            self.closeShown(animated: false)

            let session = IntroSession(request: request) { choice in
                call.resolve(["choice": choice?.rawValue ?? NSNull()])
            }
            let controller = IntroHostingController(
                rootView: IntroView(session: session) { [weak self] in
                    self?.closeShown(animated: true)
                },
                style: host.view.window?.windowScene?.screen.traitCollection.userInterfaceStyle ?? .light
            )
            self.shown = (token, session, controller)
            var top: UIViewController = host
            while let presented = top.presentedViewController, !presented.isBeingDismissed {
                top = presented
            }
            top.present(controller, animated: true)
        }
    }

    @objc func dismiss(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        DispatchQueue.main.async { [weak self] in
            if let shown = self?.shown, shown.token == token {
                self?.closeShown(animated: true)
            }
            call.resolve()
        }
    }

    /// Takes the intro down. A session that has not answered answers no
    /// choice; one that has (a door was tapped) is only taken down.
    private func closeShown(animated: Bool) {
        guard let shown = shown else { return }
        self.shown = nil
        shown.session.close()
        shown.controller.presentingViewController?.dismiss(animated: animated)
    }
}

/// Full screen over the web view, which keeps running underneath (the web
/// opens the chosen screen while the intro fades), with the status bar
/// following the intro's own light or dark surface.
final class IntroHostingController: UIHostingController<IntroView> {
    /// `style` is read from the screen. While Info.plist pins
    /// UIUserInterfaceStyle to Light (the web pages have no dark theme), iOS
    /// reports that pin through every trait, the screen's included, so this
    /// is always light and the intro's dark palette is unused. It follows
    /// the phone only if the pin moves from Info.plist to the web view's
    /// window.
    init(rootView: IntroView, style: UIUserInterfaceStyle) {
        super.init(rootView: rootView)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
        modalPresentationCapturesStatusBarAppearance = true
        isModalInPresentation = true
        overrideUserInterfaceStyle = style == .dark ? .dark : .light
        view.backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
    }
}
