import Foundation
import Capacitor

/// The web half of the native frame talks to the Swift half through this
/// plugin. Two calls, four events; the shapes are written down once, in
/// frontend/src/config/nativeFrame.ts, and frontend/tests/unit/config/
/// nativeFrame.test.ts holds this file to them.
///
/// Web -> native:
/// - `configure({ tabs, moreTitle, moreSections, signOutConfirm })`: the tab
///   labels and SF Symbols, and the More list, in the app's language.
/// - `update({ path, key, title, tab, canGoBack, largeTitle, chrome,
///   navigation, rightButton? })`: on every route change, and when the
///   page's title changes.
///
/// Native -> web (events):
/// - `tabSelect { tab, path, reselect }`, `back { path }`: the bars moved;
///   the web shows `path`.
/// - `moreSelect { id, path? }`: a More row.
/// - `rightButton { id }`: the navigation bar's trailing button.
@objc(NativeChromePlugin)
public class NativeChromePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeChromePlugin"
    public let jsName = "NativeChrome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise)
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
        let sections: [MoreSection] = (call.getArray("moreSections") as? [[String: Any]] ?? []).map { raw in
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
        let confirm = call.getObject("signOutConfirm") ?? [:]
        let configuration = FrameConfiguration(
            tabs: tabs,
            symbols: symbols,
            moreTitle: call.getString("moreTitle") ?? "",
            moreSections: sections,
            signOutTitle: confirm["title"] as? String ?? "",
            signOutConfirm: confirm["confirm"] as? String ?? "",
            signOutCancel: confirm["cancel"] as? String ?? ""
        )
        DispatchQueue.main.async { [weak self] in
            self?.frame?.configure(configuration)
            call.resolve()
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

    // Events for the web. Names and payloads as in config/nativeFrame.ts.

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
