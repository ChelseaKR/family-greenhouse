import Foundation

// The native frame's routing logic, in plain Swift with no UIKit, so it can
// be compiled and run on its own (see docs/mobile.md, "The native frame").
//
// The web reports every route change (`FrameReport`, from the NativeChrome
// plugin's `update`); `TabHistory` turns each report into the change the bars
// should make (`FrameChange`), and keeps each tab's back stack so a tab opens
// where it was left. The route -> tab map itself lives in the web
// (frontend/src/config/nativeFrame.ts), which sends the tab with each report;
// a report with no tab stays in the tab it was opened from.

/// A trailing navigation-bar button a screen asks for.
struct FrameBarButton: Equatable {
    let id: String
    let symbol: String
    let label: String
}

/// One screen in a tab's back stack.
struct FrameEntry: Equatable {
    /// pathname + search. Empty for More's first screen, which is native;
    /// `native:<id>` for another native list pushed on a tab (Settings).
    var path: String
    /// React Router's location key, or "" for a screen the web never showed
    /// yet (a tab's root placed under a deep link).
    var key: String
    var title: String
    var largeTitle: Bool
    var rightButton: FrameBarButton?

    /// A native list (More's first screen, or Settings), not a web page.
    /// The web never shows these paths, so no web report ever matches one.
    var isNativeList: Bool { path.isEmpty || path.hasPrefix(FrameEntry.nativeListPrefix) }

    static let nativeListPrefix = "native:"

    static func nativeList(title: String) -> FrameEntry {
        FrameEntry(path: "", key: "", title: title, largeTitle: true, rightButton: nil)
    }
}

enum FrameChrome: String {
    case tabs
    case none
}

enum FrameNavigation: String {
    case push
    case replace
    case pop
}

/// What the web sends on every route change.
struct FrameReport: Equatable {
    var path: String
    var key: String
    var title: String
    var tab: String?
    var canGoBack: Bool
    var largeTitle: Bool
    var chrome: FrameChrome
    var navigation: FrameNavigation
    var rightButton: FrameBarButton?
}

struct FrameTab: Equatable {
    let id: String
    let title: String
    /// The route the tab opens on; nil for More (a native list).
    let root: String?
}

/// What the bars must do after a report or a tap.
enum FrameChange: Equatable {
    /// Nothing visible changes.
    case none
    /// The top screen's title or button changed (or the web confirmed it).
    case refreshTop
    /// Sign-in, setup, signed out: no bars at all.
    case hideChrome
    /// Show this tab with its whole stack as the model has it, no animation.
    case showTab(String)
    /// A new screen on top of the current tab.
    case push
    /// Back to the screen at this depth (1 = the tab's root).
    case pop(toDepth: Int)
    /// The top screen became another route in place.
    case replaceTop
}

struct TabHistory {
    private(set) var tabs: [FrameTab]
    private(set) var moreTitle: String
    private(set) var stacks: [String: [FrameEntry]] = [:]
    private(set) var selected: String?
    private(set) var chromeShown = false
    private var lastKey: String?
    private var lastPath: String?

    init(tabs: [FrameTab], moreTitle: String = "") {
        self.tabs = tabs
        self.moreTitle = moreTitle
    }

    /// New labels (a language change) or a new tab set. Stacks of tabs that
    /// still exist are kept; their root screens take the new titles.
    mutating func configure(tabs: [FrameTab], moreTitle: String) {
        self.tabs = tabs
        self.moreTitle = moreTitle
        let ids = Set(tabs.map(\.id))
        stacks = stacks.filter { ids.contains($0.key) }
        for tab in tabs {
            guard var stack = stacks[tab.id], !stack.isEmpty else { continue }
            if stack[0].isNativeList {
                stack[0].title = moreTitle
            } else if stack[0].path == tab.root {
                stack[0].title = tab.title
            }
            stacks[tab.id] = stack
        }
        if let current = selected, !ids.contains(current) { selected = tabs.first?.id }
    }

    func stack(_ tab: String) -> [FrameEntry] { stacks[tab] ?? [] }

    var top: FrameEntry? {
        guard let tab = selected else { return nil }
        return stacks[tab]?.last
    }

    func tab(_ id: String) -> FrameTab? { tabs.first { $0.id == id } }

    /// A tab's first screen.
    func rootEntry(_ id: String) -> FrameEntry? {
        guard let tab = tab(id) else { return nil }
        guard let root = tab.root else { return .nativeList(title: moreTitle) }
        return FrameEntry(path: root, key: "", title: tab.title, largeTitle: true, rightButton: nil)
    }

    /// A stack for a report arriving in a tab with no history to keep: the
    /// report alone when it is the tab's root, otherwise on top of the root,
    /// so a deep link or a jump from another tab still has a way back.
    private func freshStack(_ tab: String, _ entry: FrameEntry, canGoBack: Bool) -> [FrameEntry] {
        guard let root = rootEntry(tab) else { return [entry] }
        if root.path == entry.path { return [entry] }
        if canGoBack || root.isNativeList { return [root, entry] }
        return [entry]
    }

    private static func entry(_ report: FrameReport) -> FrameEntry {
        FrameEntry(
            path: report.path,
            key: report.key,
            title: report.title,
            largeTitle: report.largeTitle,
            rightButton: report.rightButton
        )
    }

    /// Fold a report into the stacks; returns what the bars must do.
    mutating func apply(_ report: FrameReport) -> FrameChange {
        if report.chrome == .none {
            let wasShown = chromeShown
            reset()
            lastKey = report.key
            lastPath = report.path
            return wasShown ? .hideChrome : .none
        }

        let entry = TabHistory.entry(report)

        // The same screen again: its title or button arrived or changed.
        // Key AND path: an entry the web pushed without React Router (a deep
        // link, nativeDeepLinks.ts) has the key "default", every time.
        if chromeShown, report.key == lastKey, report.path == lastPath {
            guard let tab = selected, var stack = stacks[tab],
                  let index = stack.lastIndex(where: { $0.key == report.key && $0.path == report.path })
            else { return .none }
            let before = stack[index]
            stack[index].title = report.title
            stack[index].rightButton = report.rightButton
            stack[index].largeTitle = report.largeTitle
            stacks[tab] = stack
            return index == stack.count - 1 && stack[index] != before ? .refreshTop : .none
        }
        lastKey = report.key
        lastPath = report.path

        guard let first = tabs.first?.id else { return .none }

        if !chromeShown {
            chromeShown = true
            let tab = report.tab ?? first
            selected = tab
            stacks[tab] = freshStack(tab, entry, canGoBack: report.canGoBack)
            return .showTab(tab)
        }

        let current = selected ?? first
        let tab = report.tab ?? current

        if tab != current {
            selected = tab
            var stack = stacks[tab] ?? []
            if let index = stack.lastIndex(where: { $0.path == entry.path }) {
                stack = Array(stack.prefix(index + 1))
                stack[index] = entry
            } else {
                stack = freshStack(tab, entry, canGoBack: report.canGoBack)
            }
            stacks[tab] = stack
            return .showTab(tab)
        }

        var stack = stacks[tab] ?? []
        if stack.isEmpty {
            stacks[tab] = freshStack(tab, entry, canGoBack: report.canGoBack)
            return .showTab(tab)
        }

        // A screen already in this tab's stack: the web went back to it
        // (browser back, a link to the list it came from, or the web
        // following a native back or tab tap). Everything above it goes.
        if let index = stack.lastIndex(where: { $0.path == entry.path }) {
            let wasTop = index == stack.count - 1
            stack = Array(stack.prefix(index + 1))
            stack[index] = entry
            stacks[tab] = stack
            return wasTop ? .refreshTop : .pop(toDepth: index + 1)
        }

        // A replaced screen takes the top's place, unless the top is the
        // tab's root or a native list: neither is ever replaced away.
        let topIsRoot = stack.count == 1
        let topIsNative = stack[stack.count - 1].isNativeList
        if report.navigation != .push && !topIsRoot && !topIsNative {
            stack[stack.count - 1] = entry
            stacks[tab] = stack
            return .replaceTop
        }

        stack.append(entry)
        stacks[tab] = stack
        return .push
    }

    /// A tab was tapped. Returns the change, the route the web should show
    /// (nil for More's native list, or when nothing changes), and whether
    /// it was the tab already showing.
    mutating func select(_ tab: String) -> (change: FrameChange, path: String?, reselect: Bool) {
        guard self.tab(tab) != nil else { return (.none, nil, false) }
        if tab == selected {
            let stack = stacks[tab] ?? []
            // iOS: tapping the current tab pops to its root; at the root it
            // scrolls to the top (the controller does that on `.none`).
            if stack.count > 1 {
                stacks[tab] = [stack[0]]
                return (.pop(toDepth: 1), stack[0].isNativeList ? nil : stack[0].path, true)
            }
            return (.none, nil, true)
        }
        selected = tab
        if (stacks[tab] ?? []).isEmpty, let root = rootEntry(tab) {
            stacks[tab] = [root]
        }
        guard let top = stacks[tab]?.last else { return (.showTab(tab), nil, false) }
        return (.showTab(tab), top.isNativeList ? nil : top.path, false)
    }

    /// A native list (`native:<id>`) pushed on the current tab from a row of
    /// the list showing (More -> Settings). The web is not told: its page
    /// does not change until a row of the new list opens one.
    mutating func pushNativeList(path: String, title: String) -> FrameChange {
        guard path.hasPrefix(FrameEntry.nativeListPrefix), let tab = selected,
              var stack = stacks[tab], !stack.isEmpty else { return .none }
        if stack.last?.path == path { return .none }
        stack.append(FrameEntry(path: path, key: "", title: title, largeTitle: false, rightButton: nil))
        stacks[tab] = stack
        return .push
    }

    /// The navigation bar's back button or the edge swipe left `depth`
    /// screens in the current tab. Returns the route the web should show.
    mutating func didPop(toDepth depth: Int) -> String? {
        guard let tab = selected, let stack = stacks[tab], depth >= 1, depth < stack.count else {
            return nil
        }
        stacks[tab] = Array(stack.prefix(depth))
        let top = stacks[tab]![depth - 1]
        return top.isNativeList ? nil : top.path
    }

    /// Signed out, or back to sign-in or setup: every tab starts afresh.
    mutating func reset() {
        stacks = [:]
        selected = nil
        chromeShown = false
    }
}
