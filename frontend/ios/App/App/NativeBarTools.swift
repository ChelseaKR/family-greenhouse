import UIKit

// A screen's own tools in the navigation bar: pull-down menus beside the "+"
// and a search field the bar reveals when the list is pulled down. The web
// sends them with NativeChrome `setBarTools` (frontend/src/config/
// nativeBarTools.ts) and owns every word and choice; this file only parses
// them, draws them with UIKit and reports what was picked or typed.
//
// The parsing and the per-route store are plain Swift with no UIKit, so they
// can be checked with `swiftc` on their own.

struct BarMenuItem: Equatable {
    let id: String
    let title: String
    /// nil: a plain action. true/false: an option in a pick-one group.
    let checked: Bool?
}

struct BarMenuGroup: Equatable {
    let title: String?
    let items: [BarMenuItem]
}

struct BarMenu: Equatable {
    let id: String
    let label: String
    let symbol: String
    let groups: [BarMenuGroup]
}

struct BarSearch: Equatable {
    let placeholder: String
    let text: String
}

struct BarTools: Equatable {
    let path: String
    let menus: [BarMenu]
    let search: BarSearch?

    /// True when the route asks for nothing in the bar.
    var isEmpty: Bool { menus.isEmpty && search == nil }

    /// Builds tools from the plugin call's raw values. Anything malformed is
    /// dropped rather than drawn half-right: an item with no id or title, a
    /// group left empty by that, a menu left with no groups. Without a path
    /// there is nothing to attach the tools to, so the call fails.
    static func parse(path: String?, menus: [[String: Any]]?, search: [String: Any]?) -> BarTools? {
        guard let path = path, !path.isEmpty else { return nil }
        let parsedMenus: [BarMenu] = (menus ?? []).compactMap { raw in
            guard let id = raw["id"] as? String, !id.isEmpty,
                  let label = raw["label"] as? String,
                  let symbol = raw["symbol"] as? String else { return nil }
            let groups: [BarMenuGroup] = (raw["groups"] as? [[String: Any]] ?? []).compactMap { group in
                let items: [BarMenuItem] = (group["items"] as? [[String: Any]] ?? []).compactMap { item in
                    guard let id = item["id"] as? String, !id.isEmpty,
                          let title = item["label"] as? String, !title.isEmpty else { return nil }
                    return BarMenuItem(id: id, title: title, checked: item["checked"] as? Bool)
                }
                return items.isEmpty ? nil : BarMenuGroup(title: group["title"] as? String, items: items)
            }
            return groups.isEmpty ? nil : BarMenu(id: id, label: label, symbol: symbol, groups: groups)
        }
        var parsedSearch: BarSearch?
        if let search = search {
            parsedSearch = BarSearch(
                placeholder: search["placeholder"] as? String ?? "",
                text: search["text"] as? String ?? ""
            )
        }
        return BarTools(path: path, menus: parsedMenus, search: parsedSearch)
    }

    /// Whether `id` is an item this tools set actually offered. A pick is
    /// reported to the web only when it is: the web never hears an id it did
    /// not send.
    func offers(_ id: String) -> Bool {
        item(id) != nil
    }

    /// Whether picking `id` changes what the list shows (an option in a
    /// pick-one group: a filter or a grouping), so the page should start
    /// again at its top, where the token that explains it is.
    func reshapesList(_ id: String) -> Bool {
        item(id)?.checked != nil
    }

    private func item(_ id: String) -> BarMenuItem? {
        for menu in menus {
            for group in menu.groups {
                if let found = group.items.first(where: { $0.id == id }) { return found }
            }
        }
        return nil
    }
}

/// Tools by route. A route's tools stay while its screen can come back (a
/// pop returns to a screen that already has them); sending empty tools for a
/// route removes them.
struct BarToolsStore {
    private(set) var byPath: [String: BarTools] = [:]

    /// Stores `tools`; answers whether anything changed, so an identical send
    /// does not rebuild the bar (and close an open menu or the keyboard).
    @discardableResult
    mutating func set(_ tools: BarTools) -> Bool {
        if tools.isEmpty {
            return byPath.removeValue(forKey: tools.path) != nil
        }
        if byPath[tools.path] == tools { return false }
        byPath[tools.path] = tools
        return true
    }

    func tools(for path: String) -> BarTools? { byPath[path] }

    mutating func removeAll() { byPath = [:] }
}

/// What the search field reports: a change of text, at most once per value.
/// Programmatic text (the web's own value put back) is not reported.
struct SearchEcho {
    private(set) var lastReported: String = ""

    mutating func userTyped(_ text: String) -> String? {
        guard text != lastReported else { return nil }
        lastReported = text
        return text
    }

    mutating func webSet(_ text: String) {
        lastReported = text
    }
}

/// When the bar's search field hides. It must show at launch every time and
/// hide once the list scrolls. Installed with hide-on-scroll on, UIKit started
/// it hidden whenever the page's tools arrived after the screen appeared, and
/// turning hide-on-scroll on after one layout still caught it mid-collapse on
/// some launches (3 of 10). So it stays visible until the person first drags
/// the list, and only then hides on scroll.
enum NativeSearchVisibility {
    static func hides(afterUserScrolled: Bool) -> Bool { afterUserScrolled }
}

// MARK: - UIKit

extension BarMenu {
    /// A UIMenu with one inline section per group. Options in a pick-one
    /// group carry the system checkmark; VoiceOver reads them as selected.
    func uiMenu(onPick: @escaping (String) -> Void) -> UIMenu {
        let sections: [UIMenuElement] = groups.map { group in
            UIMenu(
                title: group.title ?? "",
                options: .displayInline,
                children: group.items.map { item in
                    UIAction(title: item.title, state: item.checked == true ? .on : .off) { _ in
                        onPick(item.id)
                    }
                }
            )
        }
        return UIMenu(title: "", children: sections)
    }
}

/// Relays the bar's search field to the web.
final class BarSearchRelay: NSObject, UISearchResultsUpdating, UISearchBarDelegate {
    let path: String
    weak var frame: NativeFrameController?
    private var echo = SearchEcho()

    init(path: String, frame: NativeFrameController?, initial: String) {
        self.path = path
        self.frame = frame
        super.init()
        echo.webSet(initial)
    }

    func updateSearchResults(for searchController: UISearchController) {
        if let text = echo.userTyped(searchController.searchBar.text ?? "") {
            frame?.barSearchChanged(path: path, text: text)
        }
    }

    func searchBarCancelButtonClicked(_ searchBar: UISearchBar) {
        if let text = echo.userTyped("") {
            frame?.barSearchChanged(path: path, text: text)
        }
    }

    func webSet(_ text: String) { echo.webSet(text) }
}
