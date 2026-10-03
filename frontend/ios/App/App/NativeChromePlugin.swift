import Foundation
import Capacitor

/// The web half of the native frame talks to the Swift half through this
/// plugin. Two calls, four events; the shapes are written down once, in
/// frontend/src/config/nativeFrame.ts, and frontend/tests/unit/config/
/// nativeFrame.test.ts holds this file to them.
///
/// Web -> native:
/// - `configure({ tabs, moreTitle, moreSections, signOutConfirm, settings })`:
///   the tab labels and SF Symbols, the More list, and Settings' list of
///   sections, in the app's language.
/// - `update({ path, key, title, tab, canGoBack, largeTitle, chrome,
///   navigation, rightButton? })`: on every route change, and when the
///   page's title changes.
///
/// Native -> web (events):
/// - `tabSelect { tab, path, reselect }`, `back { path }`: the bars moved;
///   the web shows `path`.
/// - `moreSelect { id, path? }`: a More row.
/// - `rightButton { id }`: the navigation bar's trailing button.
///
/// Alerts and action sheets (web -> native, answered):
/// - `present({ token, kind, title?, message?, actions, anchor? })` shows a
///   UIAlertController and resolves `{ id }` with the tapped action's id, or
///   `{ id: null }` for no choice (Cancel, a tap outside, the app going to the
///   background, the web closing it). NativePresentModel.swift decides.
/// - `updatePresented({ token, title?, message? })`: new words for the one
///   showing (a count that arrived after it opened).
/// - `dismissPresented({ token })`: the web closed it; it answers no choice.
///
/// A screen's own bar tools (web -> native, NativeBarTools.swift):
/// - `setBarTools({ path, menus, search })`: pull-down menus beside the "+"
///   and a search field, for the screens showing `path`.
/// - Events: `barMenuSelect { path, id }` for a picked item (only ids the web
///   sent), and `barSearch { path, text }` as the search text changes.
@objc(NativeChromePlugin)
public class NativeChromePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeChromePlugin"
    public let jsName = "NativeChrome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "present", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updatePresented", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismissPresented", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBarTools", returnType: CAPPluginReturnPromise)
    ]

    /// Set by MainViewController once the frame is built.
    weak var frame: NativeFrameController?

    @objc func configure(_ call: CAPPluginCall) {
        let tabs: [FrameTab] = (call.getArray("tabs") as? [[String: Any]] ?? []).compactMap { raw in
            guard let id = raw["id"] as? String, let title = raw["title"] as? String else { return nil }
            return FrameTab(id: id, title: title, root: raw["root"] as? String)
        }
        let symbols: [String: (String, String)] = Dictionary(
            uniqueKeysWithValues: (call.getArray("tabs") as? [[String: Any]] ?? []).compactMap { raw in
                guard let id = raw["id"] as? String else { return nil }
                return (id, (raw["symbol"] as? String ?? "circle", raw["selectedSymbol"] as? String ?? "circle.fill"))
            }
        )
        let sections = NativeChromePlugin.sections(call.getArray("moreSections"))
        let settings = call.getObject("settings") ?? [:]
        let confirm = call.getObject("signOutConfirm") ?? [:]
        let configuration = FrameConfiguration(
            tabs: tabs,
            symbols: symbols,
            moreTitle: call.getString("moreTitle") ?? "",
            moreSections: sections,
            signOutTitle: confirm["title"] as? String ?? "",
            signOutConfirm: confirm["confirm"] as? String ?? "",
            signOutCancel: confirm["cancel"] as? String ?? "",
            settingsTitle: settings["title"] as? String ?? "",
            settingsSections: NativeChromePlugin.sections(settings["sections"] as? [Any])
        )
        DispatchQueue.main.async { [weak self] in
            self?.frame?.configure(configuration)
            call.resolve()
        }
    }

    /// More's sections and Settings' sections have the same shape.
    private static func sections(_ raw: [Any]?) -> [MoreSection] {
        (raw as? [[String: Any]] ?? []).map { raw in
            MoreSection(
                title: raw["title"] as? String,
                items: (raw["items"] as? [[String: Any]] ?? []).compactMap { item in
                    guard let id = item["id"] as? String, let title = item["title"] as? String else { return nil }
                    return MoreItem(
                        id: id,
                        title: title,
                        symbol: item["symbol"] as? String,
                        path: item["path"] as? String,
                        checked: item["checked"] as? Bool ?? false,
                        destructive: item["destructive"] as? Bool ?? false
                    )
                }
            )
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let key = call.getString("key") else {
            call.reject("update needs a path and a key", "INVALID")
            return
        }
        var button: FrameBarButton?
        if let raw = call.getObject("rightButton"),
           let id = raw["id"] as? String, let symbol = raw["symbol"] as? String {
            button = FrameBarButton(id: id, symbol: symbol, label: raw["label"] as? String ?? "")
        }
        let report = FrameReport(
            path: path,
            key: key,
            title: call.getString("title") ?? "",
            tab: call.getString("tab"),
            canGoBack: call.getBool("canGoBack") ?? false,
            largeTitle: call.getBool("largeTitle") ?? false,
            chrome: FrameChrome(rawValue: call.getString("chrome") ?? "") ?? .none,
            navigation: FrameNavigation(rawValue: call.getString("navigation") ?? "") ?? .push,
            rightButton: button
        )
        DispatchQueue.main.async { [weak self] in
            self?.frame?.apply(report)
            call.resolve()
        }
    }

    @objc func present(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("present needs a token", "INVALID")
            return
        }
        let parsed = PresentRequest.parse(
            kind: call.getString("kind"),
            title: call.getString("title"),
            message: call.getString("message"),
            actions: call.getArray("actions") as? [[String: Any]]
        )
        guard let request = parsed.request else {
            call.reject(parsed.error ?? "invalid request", "INVALID")
            return
        }
        var anchor: CGRect?
        if let raw = call.getObject("anchor"),
           let x = raw["x"] as? Double, let y = raw["y"] as? Double,
           let width = raw["width"] as? Double, let height = raw["height"] as? Double {
            anchor = CGRect(x: x, y: y, width: width, height: height)
        }
        DispatchQueue.main.async { [weak self] in
            guard let frame = self?.frame else {
                call.resolve(["id": NSNull()])
                return
            }
            frame.present(request, token: token, anchor: anchor) { id in
                call.resolve(["id": id ?? NSNull()])
            }
        }
    }

    @objc func updatePresented(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        let title = call.getString("title")
        let message = call.getString("message")
        DispatchQueue.main.async { [weak self] in
            self?.frame?.updatePresented(token: token, title: title, message: message)
            call.resolve()
        }
    }

    @objc func dismissPresented(_ call: CAPPluginCall) {
        let token = call.getString("token") ?? ""
        DispatchQueue.main.async { [weak self] in
            self?.frame?.dismissPresented(token: token)
            call.resolve()
        }
    }

    @objc func setBarTools(_ call: CAPPluginCall) {
        guard let tools = BarTools.parse(
            path: call.getString("path"),
            menus: call.getArray("menus") as? [[String: Any]],
            search: call.getObject("search")
        ) else {
            call.reject("setBarTools needs a path", "INVALID")
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.frame?.setBarTools(tools)
            call.resolve()
        }
    }

    // Events for the web. Names and payloads as in config/nativeFrame.ts
    // and config/nativeBarTools.ts.

    func sendBarMenuSelect(path: String, id: String) {
        notifyListeners("barMenuSelect", data: ["path": path, "id": id])
    }

    func sendBarSearch(path: String, text: String) {
        notifyListeners("barSearch", data: ["path": path, "text": text])
    }

    func sendTabSelect(tab: String, path: String?, reselect: Bool) {
        notifyListeners("tabSelect", data: ["tab": tab, "path": path ?? NSNull(), "reselect": reselect])
    }

    func sendBack(path: String) {
        notifyListeners("back", data: ["path": path])
    }

    func sendMoreSelect(id: String, path: String?) {
        var data: [String: Any] = ["id": id]
        if let path = path { data["path"] = path }
        notifyListeners("moreSelect", data: data)
    }

    func sendRightButton(id: String) {
        notifyListeners("rightButton", data: ["id": id])
    }
}
