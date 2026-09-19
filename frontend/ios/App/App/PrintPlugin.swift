import UIKit
import Capacitor

/// Prints the page the app is showing, through the iOS print sheet.
///
/// `window.print()` does nothing in a WKWebView: WebKit hands the request to
/// its UI delegate, and the delegate method for it is private API. So the
/// print buttons on the plant passport, the plant tags sheet, the sitter brief
/// and the caretaker report were dead in the app (found in the App Store
/// review of 0.37.0). `frontend/src/services/nativePrint.ts` calls this
/// plugin instead.
///
/// The web view's own print formatter lays the page out with its print
/// styles, the same `print:` rules a browser uses, so what comes out matches
/// the website's printout. The sheet offers AirPrint, and its share button
/// saves or sends the printout as a PDF, so a phone with no printer nearby
/// still gets the document.
///
/// It lives in the app target rather than an npm package: it is one UIKit
/// call, and MainViewController registers it.
@objc(PrintPlugin)
public class PrintPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PrintPlugin"
    public let jsName = "Print"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise)
    ]

    /// Options: `jobName` (the document's title), and on iPad the tapped
    /// button's rectangle in web view points (`anchorX`, `anchorY`,
    /// `anchorWidth`, `anchorHeight`), which the sheet's popover points at.
    /// Resolves `{ completed }`: false when the person closed the sheet.
    @objc func print(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.bridge?.webView else {
                call.reject("The page is not ready to print.", "UNAVAILABLE")
                return
            }
            guard UIPrintInteractionController.isPrintingAvailable else {
                call.reject("Printing is not available on this device.", "UNAVAILABLE")
                return
            }

            let info = UIPrintInfo.printInfo()
            info.outputType = .general
            info.jobName = call.getString("jobName") ?? "Family Greenhouse"

            let controller = UIPrintInteractionController.shared
            controller.printInfo = info
            controller.printFormatter = webView.viewPrintFormatter()

            let finished: UIPrintInteractionController.CompletionHandler = { _, completed, error in
                if let error = error {
                    call.reject(error.localizedDescription, "FAILED", error)
                } else {
                    call.resolve(["completed": completed])
                }
            }

            let shown: Bool
            if UIDevice.current.userInterfaceIdiom == .pad {
                shown = controller.present(
                    from: PrintPlugin.anchor(for: call, in: webView),
                    in: webView,
                    animated: true,
                    completionHandler: finished
                )
            } else {
                shown = controller.present(animated: true, completionHandler: finished)
            }
            if !shown {
                call.reject("The print sheet could not open.", "FAILED")
            }
        }
    }

    /// The tapped button, or the middle of the page when there is none.
    private static func anchor(for call: CAPPluginCall, in view: UIView) -> CGRect {
        if let x = call.getDouble("anchorX"),
           let y = call.getDouble("anchorY"),
           let width = call.getDouble("anchorWidth"),
           let height = call.getDouble("anchorHeight"),
           width > 0, height > 0 {
            return CGRect(x: x, y: y, width: width, height: height)
        }
        return CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
    }
}
