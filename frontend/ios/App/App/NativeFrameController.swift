import UIKit
import WebKit

// The native frame: Apple's own tab bar and navigation bar around the app's
// ONE web view. The web view moves into whichever screen is showing; every
// other screen in a tab's stack shows the last picture of its page, so the
// system push, pop and edge-swipe animations have something real to slide.
//
// TabHistory (NativeFrameModel.swift) decides; this file only carries its
// decisions out in UIKit and reports taps back through NativeChromePlugin.

struct MoreItem: Equatable {
    let id: String
    let title: String
    let symbol: String?
    let path: String?
    let checked: Bool
    let destructive: Bool
}

struct MoreSection: Equatable {
    let title: String?
    let items: [MoreItem]
}

struct FrameConfiguration {
    let tabs: [FrameTab]
    /// Tab id -> (SF Symbol, its filled form for the selected tab).
    let symbols: [String: (String, String)]
    let moreTitle: String
    let moreSections: [MoreSection]
    let signOutTitle: String
    let signOutConfirm: String
    let signOutCancel: String
    /// Settings as a native list, pushed on More from its Settings row
    /// (`native:settings`); each row opens that section's web page.
    let settingsTitle: String
    let settingsSections: [MoreSection]
}

enum FrameColors {
    /// `--color-paper` in frontend/src/index.css: the page behind every screen.
    static let paper = UIColor(red: 0xF7 / 255, green: 0xF8 / 255, blue: 0xF2 / 255, alpha: 1)
    /// `--color-primary-700`: the selected tab and the bar buttons.
    static let tint = UIColor(red: 0x3B / 255, green: 0x6D / 255, blue: 0x11 / 255, alpha: 1)
}

/// One screen of a tab: holds the web view while it shows, a picture of its
/// page while it does not.
final class WebScreenController: UIViewController {
    var entry: FrameEntry
    weak var frame: NativeFrameController?
    /// Where the page was scrolled when the web view last left this screen.
    var savedOffset: CGPoint?
    /// The page as it last settled (after it loaded, after a scroll ended).
    var settledSnapshot: UIView?
    var settledOffset: CGPoint?
    private var snapshot: UIView?

    init(entry: FrameEntry, frame: NativeFrameController?) {
        self.entry = entry
        self.frame = frame
        super.init(nibName: nil, bundle: nil)
        applyEntry()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = FrameColors.paper
    }

    /// The tools last drawn, so an identical set does not rebuild the bar.
    private var drawnTools: BarTools?
    private var searchRelay: BarSearchRelay?

    func applyEntry() {
        title = entry.title
        navigationItem.largeTitleDisplayMode = entry.largeTitle ? .always : .never
        applyBarItems()
    }

    /// The trailing bar: the "+" first (rightmost), then the screen's own
    /// menus (NativeBarTools.swift), and its search field, if it has one.
    func applyBarItems() {
        let tools = frame?.barTools(for: entry.path)
        var items: [UIBarButtonItem] = []
        if let button = entry.rightButton {
            let item = UIBarButtonItem(
                image: UIImage(systemName: button.symbol),
                primaryAction: UIAction { [weak self] _ in
                    self?.frame?.rightButtonTapped(button.id)
                }
            )
            item.accessibilityLabel = button.label
            items.append(item)
        }
        let path = entry.path
        for menu in tools?.menus ?? [] {
            let item = UIBarButtonItem(
                image: UIImage(systemName: menu.symbol),
                menu: menu.uiMenu { [weak self] id in
                    self?.frame?.barMenuPicked(path: path, id: id)
                }
            )
            item.accessibilityLabel = menu.label
            item.accessibilityIdentifier = "barMenu.\(menu.id)"
            items.append(item)
        }
        navigationItem.rightBarButtonItems = items
        applySearch(tools?.search)
        drawnTools = tools
    }

    private func applySearch(_ search: BarSearch?) {
        guard let search = search else {
            navigationItem.searchController = nil
            searchRelay = nil
            return
        }
        if let controller = navigationItem.searchController, let relay = searchRelay {
            controller.searchBar.placeholder = search.placeholder
            // The web's value, put back only when it differs (a filter reset
            // the query); never while someone is typing in it.
            if !controller.searchBar.isFirstResponder, controller.searchBar.text != search.text {
                relay.webSet(search.text)
                controller.searchBar.text = search.text
            }
            return
        }
        let relay = BarSearchRelay(path: entry.path, frame: frame, initial: search.text)
        let controller = UISearchController(searchResultsController: nil)
        controller.obscuresBackgroundDuringPresentation = false
        controller.searchResultsUpdater = relay
        controller.searchBar.delegate = relay
        controller.searchBar.placeholder = search.placeholder
        controller.searchBar.text = search.text
        controller.searchBar.tintColor = FrameColors.tint
        searchRelay = relay
        navigationItem.searchController = controller
        // Showing at launch, hidden once the list scrolls, and revealed by
        // pulling it down: the standard iOS behavior. The page's tools can
        // arrive after this screen has appeared, and UIKit then starts a
        // search bar that hides on scroll already hidden (or half hidden), so
        // whether it showed at launch depended on timing. It is installed
        // always-visible and starts hiding on scroll from the first time the
        // person drags the list (`userBeganScrolling`), so it shows at launch
        // every time. NativeSearchVisibility holds the rule.
        navigationItem.hidesSearchBarWhenScrolling = NativeSearchVisibility.hides(afterUserScrolled: false)
        // Arriving after the screen appeared, the field can also leave the
        // large title collapsed (about 1 launch in 10). On a list nobody has
        // touched yet, settle it at its top, large title and field showing.
        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.userHasScrolled else { return }
            self.frame?.settleAtTop(self)
        }
    }

    /// Whether the person has dragged this screen's list yet.
    private(set) var userHasScrolled = false

    /// The person started dragging this screen's list: from now on the search
    /// field hides when the list scrolls, and a pull down reveals it.
    func userBeganScrolling() {
        userHasScrolled = true
        guard navigationItem.searchController != nil else { return }
        let hides = NativeSearchVisibility.hides(afterUserScrolled: true)
        if navigationItem.hidesSearchBarWhenScrolling != hides {
            navigationItem.hidesSearchBarWhenScrolling = hides
        }
    }

    /// Redraws only when this screen's tools changed.
    func barToolsChanged() {
        let tools = frame?.barTools(for: entry.path)
        if tools != drawnTools { applyBarItems() }
    }

    /// Show a picture over (or instead of) the live page.
    func showSnapshot(_ picture: UIView?) {
        snapshot?.removeFromSuperview()
        snapshot = picture
        guard let picture = picture else { return }
        picture.frame = view.bounds
        picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        picture.isUserInteractionEnabled = false
        view.addSubview(picture)
    }

    var hasSnapshot: Bool { snapshot != nil }

    /// Take the picture away and show the live page under it.
    func revealLivePage(animated: Bool) {
        guard let picture = snapshot else { return }
        snapshot = nil
        guard animated else {
            picture.removeFromSuperview()
            return
        }
        UIView.animate(withDuration: 0.15, animations: { picture.alpha = 0 }, completion: { _ in
            picture.removeFromSuperview()
        })
    }
}

/// More's first screen: everything the web drawer held that is not a tab.
/// Also Settings' list of sections, pushed on More (inline title).
final class MoreListController: UITableViewController {
    weak var frame: NativeFrameController?
    var sections: [MoreSection] = [] {
        didSet { if isViewLoaded { tableView.reloadData() } }
    }

    init(frame: NativeFrameController?, largeTitle: Bool = true) {
        self.frame = frame
        super.init(style: .insetGrouped)
        navigationItem.largeTitleDisplayMode = largeTitle ? .always : .never
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        // The checkmark on the active household, in the app's green.
        tableView.tintColor = FrameColors.tint
    }

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        sections[section].items.count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        sections[section].title
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let item = sections[indexPath.section].items[indexPath.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = item.title
        if let symbol = item.symbol {
            content.image = UIImage(systemName: symbol)
            content.imageProperties.tintColor = item.destructive ? .systemRed : FrameColors.tint
        }
        if item.destructive {
            content.textProperties.color = .systemRed
        }
        cell.contentConfiguration = content
        cell.accessoryType = item.checked ? .checkmark : (item.path != nil ? .disclosureIndicator : .none)
        cell.accessibilityTraits = item.checked ? [.button, .selected] : .button
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let item = sections[indexPath.section].items[indexPath.row]
        frame?.moreItemChosen(item, from: tableView.cellForRow(at: indexPath))
    }
}

final class NativeFrameController: NSObject, UITabBarControllerDelegate, UINavigationControllerDelegate {
    private weak var host: UIViewController?
    let webView: WKWebView
    private(set) weak var plugin: NativeChromePlugin?
    /// Holds the web view, full screen, while there are no bars.
    private let bareHost = UIView()
    let tabBarController = UITabBarController()
    private var navigators: [String: UINavigationController] = [:]
    private(set) var moreList: MoreListController?
    /// Settings' sections (`native:settings`), made the first time it opens.
    private(set) var settingsList: MoreListController?
    static let settingsListPath = "\(FrameEntry.nativeListPrefix)settings"
    private var history = TabHistory(tabs: [])
    private var configuration: FrameConfiguration?
    private var waiting: [FrameReport] = []
    private weak var liveScreen: WebScreenController?
    /// The screen whose picture stays up until the web shows its page.
    private var revealWhenShown: (screen: WebScreenController, path: String, restore: CGPoint?)?
    private var revealDeadline: DispatchWorkItem?
    /// A tab chosen in shouldSelect, reported to the web once it shows.
    private var pendingTabSelect: (tab: String, path: String?)?
    private var settleWork: DispatchWorkItem?
    private var scrollObservation: NSKeyValueObservation?

    private var launchBackground: UIColor?

    /// Each route's own bar menus and search (NativeChrome `setBarTools`).
    private var barToolsStore = BarToolsStore()

    /// The alert or action sheet the web asked for, while it shows. Weak:
    /// when UIKit lets go of the alert, its outcome answers on its own.
    private final class Presented {
        let token: String
        weak var alert: UIAlertController?
        weak var outcome: PresentOutcome?
        init(token: String, alert: UIAlertController, outcome: PresentOutcome) {
            self.token = token
            self.alert = alert
            self.outcome = outcome
        }
    }
    private var presented: Presented?
    /// The form sheet the web asked for, while it shows (NativeChrome
    /// `presentForm`). Weak: when UIKit lets go of it, its outcome answers.
    private weak var formSheet: FormSheetController?
    private var backgroundObserver: NSObjectProtocol?

    /// True while the tab bar and navigation bar are showing.
    private(set) var chromeVisible = false

    /// Called when the bars appear or go (MainViewController re-decides the
    /// web view's own edge swipe then).
    var onChromeVisibilityChange: (() -> Void)?

    init(host: UIViewController, webView: WKWebView, plugin: NativeChromePlugin) {
        self.host = host
        self.webView = webView
        self.plugin = plugin
        super.init()
    }

    private var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    /// Replaces the host's view (the web view, as Capacitor set it) with a
    /// container holding the tab bar controller and the bare host.
    func install() {
        guard let host = host else { return }
        let container = UIView(frame: host.view.bounds)
        container.backgroundColor = FrameColors.paper
        host.view = container

        host.addChild(tabBarController)
        tabBarController.view.frame = container.bounds
        tabBarController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(tabBarController.view)
        tabBarController.didMove(toParent: host)
        tabBarController.delegate = self
        tabBarController.view.isHidden = true
        tabBarController.tabBar.tintColor = FrameColors.tint

        bareHost.frame = container.bounds
        bareHost.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        bareHost.backgroundColor = FrameColors.paper
        container.addSubview(bareHost)
        moveWebView(into: bareHost)

        // The page decides where its own scrolling ends; remember where it
        // settled so a screen left behind keeps an up-to-date picture.
        scrollObservation = webView.scrollView.observe(\.contentOffset, options: [.new]) { [weak self] scrollView, _ in
            self?.scheduleSettledSnapshot(after: 0.35)
            // Only a finger on the list counts, not the page's own scrolling.
            if scrollView.isTracking { self?.liveScreen?.userBeganScrolling() }
        }

        // A confirmation left up when the app goes to the background is
        // closed as no choice: back in the app, the resume refresh may have
        // changed what it was asking about.
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.dismissPresented(token: nil)
        }
    }

    /// Capacitor's launch screen is drawn inside the web view. Lift it above
    /// the bars, so they appear under it, not over it. Called once, after
    /// the launch screen has been put up.
    func liftLaunchScreen() {
        guard let container = host?.view else { return }
        for view in webView.subviews where view !== webView.scrollView {
            let name = String(describing: type(of: view))
            if name.hasPrefix("WK") || name.hasPrefix("_") { continue }
            container.addSubview(view)
        }
    }

    // MARK: - From the web

    func configure(_ configuration: FrameConfiguration) {
        let firstTime = self.configuration == nil
        let sameTabs = self.configuration?.tabs.map(\.id) == configuration.tabs.map(\.id)
        self.configuration = configuration
        history.configure(tabs: configuration.tabs, moreTitle: configuration.moreTitle)

        if firstTime || !sameTabs {
            buildTabs(configuration)
        } else {
            for tab in configuration.tabs {
                guard let navigator = navigators[tab.id] else { continue }
                navigator.tabBarItem.title = tab.title
                (navigator.viewControllers.first as? WebScreenController)?.entry.title = tab.title
                (navigator.viewControllers.first as? WebScreenController)?.applyEntry()
            }
        }
        moreList?.title = configuration.moreTitle
        moreList?.sections = configuration.moreSections
        settingsList?.title = configuration.settingsTitle
        settingsList?.sections = configuration.settingsSections

        let queued = waiting
        waiting = []
        for report in queued { apply(report) }
    }

    func apply(_ report: FrameReport) {
        guard configuration != nil else {
            waiting.append(report)
            return
        }
        let change = history.apply(report)
        render(change)
        if let pending = revealWhenShown, pending.path == report.path, pending.screen === liveScreen {
            reveal()
        }
    }

    // MARK: - Building

    private func buildTabs(_ configuration: FrameConfiguration) {
        navigators = [:]
        var controllers: [UIViewController] = []
        for tab in configuration.tabs {
            let root: UIViewController
            if tab.root == nil {
                let list = MoreListController(frame: self)
                list.title = configuration.moreTitle
                list.sections = configuration.moreSections
                moreList = list
                root = list
            } else {
                root = WebScreenController(entry: history.rootEntry(tab.id)!, frame: self)
            }
            let navigator = UINavigationController(rootViewController: root)
            navigator.navigationBar.prefersLargeTitles = true
            navigator.navigationBar.tintColor = FrameColors.tint
            navigator.delegate = self
            let symbols = configuration.symbols[tab.id]
            navigator.tabBarItem = UITabBarItem(
                title: tab.title,
                image: symbols.flatMap { UIImage(systemName: $0.0) },
                selectedImage: symbols.flatMap { UIImage(systemName: $0.1) }
            )
            navigators[tab.id] = navigator
            controllers.append(navigator)
        }
        tabBarController.setViewControllers(controllers, animated: false)
    }

    /// Make the tab's navigation stack match the model's, reusing every
    /// screen that is still the same route.
    private func syncStack(_ tab: String) {
        guard let navigator = navigators[tab] else { return }
        let model = history.stack(tab)
        let current = navigator.viewControllers
        var next: [UIViewController] = []
        for (index, entry) in model.enumerated() {
            if entry.isNativeList {
                if let list = nativeList(for: entry) { next.append(list) }
                continue
            }
            if index < current.count, let screen = current[index] as? WebScreenController,
               screen.entry.path == entry.path {
                screen.entry = entry
                screen.applyEntry()
                next.append(screen)
            } else {
                next.append(WebScreenController(entry: entry, frame: self))
            }
        }
        if next.isEmpty { return }
        if next.map(ObjectIdentifier.init) != current.map(ObjectIdentifier.init) {
            navigator.setViewControllers(next, animated: false)
        }
    }

    /// The controller for a native list entry: More's first screen, or Settings.
    private func nativeList(for entry: FrameEntry) -> MoreListController? {
        if entry.path.isEmpty { return moreList }
        guard entry.path == NativeFrameController.settingsListPath, let configuration = configuration else {
            return nil
        }
        if settingsList == nil {
            let list = MoreListController(frame: self, largeTitle: false)
            list.title = configuration.settingsTitle
            list.sections = configuration.settingsSections
            settingsList = list
        }
        return settingsList
    }

    var selectedNavigator: UINavigationController? {
        guard let tab = history.selected else { return nil }
        return navigators[tab]
    }

    var topScreen: WebScreenController? {
        selectedNavigator?.topViewController as? WebScreenController
    }

    // MARK: - Carrying out a change

    private func render(_ change: FrameChange) {
        switch change {
        case .none:
            break
        case .hideChrome:
            setChromeVisible(false)
        case .refreshTop:
            if let screen = topScreen, let entry = history.top {
                screen.entry = entry
                screen.applyEntry()
                scheduleSettledSnapshot(after: 0.4)
            }
        case .showTab(let tab):
            setChromeVisible(true)
            leaveLiveScreen(pageAlreadyChanged: true)
            syncStack(tab)
            if let index = history.tabs.firstIndex(where: { $0.id == tab }),
               tabBarController.selectedIndex != index {
                tabBarController.selectedIndex = index
            }
            if let screen = topScreen {
                attach(to: screen)
                scrollToTop(animated: false)
            }
        case .push:
            guard let navigator = selectedNavigator, let entry = history.top else { return }
            if entry.isNativeList {
                // A native list from a row of the list showing: the page
                // has not changed, and the web view stays where it is.
                leaveLiveScreen(pageAlreadyChanged: false)
                if let list = nativeList(for: entry), navigator.topViewController !== list {
                    navigator.pushViewController(list, animated: !reduceMotion)
                }
                return
            }
            leaveLiveScreen(pageAlreadyChanged: true)
            let screen = WebScreenController(entry: entry, frame: self)
            navigator.pushViewController(screen, animated: !reduceMotion)
            attach(to: screen)
            scrollToTop(animated: false)
        case .pop(let depth):
            guard let navigator = selectedNavigator, depth >= 1,
                  depth <= navigator.viewControllers.count else { return }
            leaveLiveScreen(pageAlreadyChanged: true)
            let target = navigator.viewControllers[depth - 1]
            navigator.popToViewController(target, animated: !reduceMotion)
            if let screen = target as? WebScreenController {
                if let entry = history.top { screen.entry = entry; screen.applyEntry() }
                let offset = screen.savedOffset
                attach(to: screen)
                screen.revealLivePage(animated: false)
                restore(offset)
            }
        case .replaceTop:
            guard let screen = topScreen, let entry = history.top else { return }
            screen.entry = entry
            screen.applyEntry()
            scrollToTop(animated: false)
        }
    }

    private func setChromeVisible(_ visible: Bool) {
        guard visible != chromeVisible else { return }
        chromeVisible = visible
        if visible {
            webView.scrollView.contentInsetAdjustmentBehavior = .automatic
            // Under the glass bars the page is paper; the forest launch
            // color stays for sign-in and setup, which run under the
            // status bar on their own.
            launchBackground = webView.scrollView.backgroundColor
            webView.backgroundColor = FrameColors.paper
            webView.scrollView.backgroundColor = FrameColors.paper
            tabBarController.view.isHidden = false
            bareHost.isHidden = true
        } else {
            webView.backgroundColor = launchBackground
            webView.scrollView.backgroundColor = launchBackground
            leaveLiveScreen(pageAlreadyChanged: true)
            revealWhenShown = nil
            moveWebView(into: bareHost)
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            bareHost.isHidden = false
            tabBarController.view.isHidden = true
            // Signed out: drop every stack, and the pictures they held.
            for (tab, navigator) in navigators {
                if let root = navigator.viewControllers.first {
                    if let screen = root as? WebScreenController, let entry = history.rootEntry(tab) {
                        screen.entry = entry
                        screen.applyEntry()
                        screen.showSnapshot(nil)
                        screen.settledSnapshot = nil
                    }
                    navigator.setViewControllers([root], animated: false)
                }
            }
            tabBarController.selectedIndex = 0
        }
        onChromeVisibilityChange?()
    }

    private func moveWebView(into view: UIView) {
        if webView.superview !== view {
            webView.removeFromSuperview()
            webView.frame = view.bounds
            webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.insertSubview(webView, at: 0)
        }
    }

    /// The live screen gives up the web view and keeps a picture of its
    /// page. When the page has already changed (the web navigated first),
    /// the picture is the one taken when it last settled.
    private func leaveLiveScreen(pageAlreadyChanged: Bool) {
        guard let screen = liveScreen else { return }
        // One scroll view, one bar: measured in the simulator, a scroll view
        // still registered with the screen it left kept driving that
        // screen's bar, and the next tab's large title never drew.
        screen.setContentScrollView(nil, for: .top)
        if pageAlreadyChanged {
            screen.showSnapshot(screen.settledSnapshot)
            screen.savedOffset = screen.settledOffset ?? screen.savedOffset
        } else {
            screen.showSnapshot(webView.snapshotView(afterScreenUpdates: false))
            screen.savedOffset = webView.scrollView.contentOffset
        }
        liveScreen = nil
    }

    private func attach(to screen: WebScreenController) {
        if let previous = liveScreen, previous !== screen {
            previous.setContentScrollView(nil, for: .top)
        }
        screen.loadViewIfNeeded()
        moveWebView(into: screen.view)
        screen.setContentScrollView(webView.scrollView, for: .top)
        liveScreen = screen
        screen.revealLivePage(animated: false)
    }

    /// The web view moves to a screen whose page the web has yet to show
    /// (a tab tap, a back): the screen's picture stays over it until the
    /// web reports that route, then the scroll position comes back.
    private func attachShowingPicture(to screen: WebScreenController) {
        if let previous = liveScreen, previous !== screen {
            previous.setContentScrollView(nil, for: .top)
        }
        let picture = screen.hasSnapshot ? nil : screen.settledSnapshot
        let offset = screen.savedOffset
        screen.loadViewIfNeeded()
        moveWebView(into: screen.view)
        screen.setContentScrollView(webView.scrollView, for: .top)
        liveScreen = screen
        if let picture = picture { screen.showSnapshot(picture) }
        revealWhenShown = (screen, screen.entry.path, offset)
        revealDeadline?.cancel()
        let deadline = DispatchWorkItem { [weak self] in self?.reveal() }
        revealDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: deadline)
    }

    private func reveal() {
        revealDeadline?.cancel()
        guard let pending = revealWhenShown else { return }
        revealWhenShown = nil
        // One turn for the page to lay out before its scroll position returns.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // A screen seen before comes back where it was left; one never
            // shown opens at its top (the web view still has the last
            // page's scroll position).
            if let offset = pending.restore {
                self.restore(offset)
            } else {
                self.scrollToTop(animated: false)
            }
            pending.screen.revealLivePage(animated: !self.reduceMotion)
            self.scheduleSettledSnapshot(after: 0.4)
        }
    }

    private func restore(_ offset: CGPoint?, retry: Bool = true) {
        guard let offset = offset else { return }
        let scrollView = webView.scrollView
        liveScreen?.view.layoutIfNeeded()
        let top = -scrollView.adjustedContentInset.top
        if offset.y <= top + 1 {
            scrollToTop(animated: false)
            return
        }
        let bottom = max(top, scrollView.contentSize.height - scrollView.bounds.height
            + scrollView.adjustedContentInset.bottom)
        let placed = CGPoint(x: offset.x, y: min(offset.y, bottom))
        scrollView.setContentOffset(placed, animated: false)
        // Measured: a page whose content was still arriving was shorter than
        // the saved position and clamped it. Once more, after it has grown,
        // unless the person has scrolled since.
        guard placed.y < offset.y, retry else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self = self, self.webView.scrollView.contentOffset == placed else { return }
            self.restore(offset, retry: false)
        }
    }

    /// The top of the page, and on a tab's first screen the expanded large
    /// title. Measured in the simulator: a bar that came up inline stays
    /// inline at the top, because it expands only when the page is pulled
    /// past its top, and this web view's scroll view never bounces (the
    /// page's pull to refresh owns that gesture). So the page is put past its
    /// top once; UIKit expands the bar and settles the offset itself.
    /// Puts `screen`'s list at its top, large title expanded, if it is the
    /// screen showing (see WebScreenController's `applySearch`).
    func settleAtTop(_ screen: WebScreenController) {
        guard screen === liveScreen else { return }
        scrollToTop(animated: false)
    }

    private func scrollToTop(animated: Bool) {
        let scrollView = webView.scrollView
        liveScreen?.view.layoutIfNeeded()
        let top = -scrollView.adjustedContentInset.top
        if liveScreen?.entry.largeTitle == true {
            scrollView.setContentOffset(CGPoint(x: 0, y: top - 120), animated: false)
            liveScreen?.view.layoutIfNeeded()
            scrollView.setContentOffset(
                CGPoint(x: 0, y: -scrollView.adjustedContentInset.top), animated: animated)
        } else {
            scrollView.setContentOffset(CGPoint(x: 0, y: top), animated: animated)
        }
    }

    private func scheduleSettledSnapshot(after delay: TimeInterval) {
        settleWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, let screen = self.liveScreen, !screen.hasSnapshot,
                  self.chromeVisible, self.revealWhenShown == nil else { return }
            screen.settledSnapshot = self.webView.snapshotView(afterScreenUpdates: false)
            screen.settledOffset = self.webView.scrollView.contentOffset
        }
        settleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: - Taps

    func tabBarController(_ tabBarController: UITabBarController,
                          shouldSelect viewController: UIViewController) -> Bool {
        guard let tab = navigators.first(where: { $0.value === viewController })?.key else { return true }
        guard tab == history.selected else {
            // Another tab. The web view moves into its screen BEFORE UIKit
            // shows it, with the page past its top: measured in the
            // simulator, a bar that first appears with its scroll view at
            // the top lays out its large title, while one expanded after it
            // appeared kept an empty title area.
            leaveLiveScreen(pageAlreadyChanged: false)
            let result = history.select(tab)
            syncStack(tab)
            if let screen = navigators[tab]?.topViewController as? WebScreenController {
                attachShowingPicture(to: screen)
                if screen.savedOffset == nil || screen.entry.largeTitle {
                    webView.scrollView.contentOffset = CGPoint(x: 0, y: -2000)
                }
            }
            pendingTabSelect = (tab, result.path)
            return true
        }

        // The tab already showing: back to its root, or at the root, to the top.
        let result = history.select(tab)
        guard let navigator = navigators[tab] else { return false }
        if case .pop = result.change {
            leaveLiveScreen(pageAlreadyChanged: false)
            navigator.popToRootViewController(animated: !reduceMotion)
            if let root = navigator.viewControllers.first as? WebScreenController {
                attachShowingPicture(to: root)
            }
            plugin?.sendTabSelect(tab: tab, path: result.path, reselect: true)
        } else if let list = navigator.topViewController as? MoreListController {
            list.tableView.setContentOffset(
                CGPoint(x: 0, y: -list.tableView.adjustedContentInset.top), animated: !reduceMotion)
        } else {
            scrollToTop(animated: !reduceMotion)
        }
        return false
    }

    func tabBarController(_ tabBarController: UITabBarController,
                          didSelect viewController: UIViewController) {
        guard let pending = pendingTabSelect else { return }
        pendingTabSelect = nil
        plugin?.sendTabSelect(tab: pending.tab, path: pending.path, reselect: false)
    }

    /// After the back button, the edge swipe, or a pop this controller made.
    func navigationController(_ navigationController: UINavigationController,
                              didShow viewController: UIViewController, animated: Bool) {
        guard let tab = navigators.first(where: { $0.value === navigationController })?.key,
              tab == history.selected else { return }
        let shown = navigationController.viewControllers.count
        guard shown < history.stack(tab).count else { return }
        // The system popped (back button or swipe); the model follows and
        // the web is told which page to show.
        let path = history.didPop(toDepth: shown)
        if liveScreen?.parent == nil { liveScreen = nil }
        if let screen = viewController as? WebScreenController {
            attachShowingPicture(to: screen)
        }
        if let path = path { plugin?.sendBack(path: path) }
    }

    func moreItemChosen(_ item: MoreItem, from cell: UITableViewCell?) {
        guard let configuration = configuration else { return }
        if item.destructive {
            let sheet = UIAlertController(title: configuration.signOutTitle, message: nil,
                                          preferredStyle: .actionSheet)
            sheet.addAction(UIAlertAction(title: configuration.signOutConfirm, style: .destructive) { [weak self] _ in
                self?.plugin?.sendMoreSelect(id: item.id, path: item.path)
            })
            sheet.addAction(UIAlertAction(title: configuration.signOutCancel, style: .cancel))
            if let popover = sheet.popoverPresentationController, let cell = cell {
                popover.sourceView = cell
                popover.sourceRect = cell.bounds
            }
            host?.present(sheet, animated: !reduceMotion)
            return
        }
        if let path = item.path, path.hasPrefix(FrameEntry.nativeListPrefix) {
            render(history.pushNativeList(path: path, title: item.title))
            return
        }
        plugin?.sendMoreSelect(id: item.id, path: item.path)
    }

    func rightButtonTapped(_ id: String) {
        plugin?.sendRightButton(id: id)
    }

    // MARK: - A screen's bar tools (NativeChrome `setBarTools`)

    func barTools(for path: String) -> BarTools? { barToolsStore.tools(for: path) }

    func setBarTools(_ tools: BarTools) {
        guard barToolsStore.set(tools) else { return }
        for navigator in navigators.values {
            for case let screen as WebScreenController in navigator.viewControllers
            where screen.entry.path == tools.path {
                screen.barToolsChanged()
            }
        }
    }

    func barMenuPicked(path: String, id: String) {
        // Only an id the web offered for this route goes back to it.
        guard let tools = barToolsStore.tools(for: path), tools.offers(id) else { return }
        plugin?.sendBarMenuSelect(path: path, id: id)
        if tools.reshapesList(id), liveScreen?.entry.path == path {
            // A filter or grouping reshapes the list: back to its top, large
            // title and search field showing, once the page has re-rendered
            // (a shorter page would otherwise clamp the scroll again).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                guard let self = self, self.liveScreen?.entry.path == path else { return }
                self.scrollToTop(animated: !self.reduceMotion)
            }
        }
    }

    func barSearchChanged(path: String, text: String) {
        plugin?.sendBarSearch(path: path, text: text)
    }

    // MARK: - Alerts and action sheets (NativeChrome `present`)

    /// Shows a UIAlertController for the web and calls `completion` once:
    /// with the tapped action's id, or nil for no choice. Only a tap on a
    /// button that is not the cancel button is a choice (PresentOutcome).
    func present(_ request: PresentRequest, token: String, anchor: CGRect?,
                 retried: Bool = false, completion: @escaping (String?) -> Void) {
        // One at a time: whatever is showing ends as no choice first.
        dismissPresented(token: nil)

        guard let presenter = topPresenter() else {
            completion(nil)
            return
        }
        // An alert that is still sliding away (one answered a moment ago)
        // blocks a new one; try once more when it has gone.
        if presenter.presentedViewController?.isBeingDismissed == true {
            guard !retried else {
                completion(nil)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                guard let self = self else { return completion(nil) }
                self.present(request, token: token, anchor: anchor, retried: true, completion: completion)
            }
            return
        }

        let outcome = PresentOutcome(completion: completion)
        let alert = UIAlertController(
            title: request.title,
            message: request.message,
            preferredStyle: request.kind == .actionSheet ? .actionSheet : .alert
        )
        for action in request.actions {
            // The handlers hold the outcome; the alert holds the handlers.
            // UIKit runs a handler only for a tap on that button.
            alert.addAction(UIAlertAction(title: action.title, style: action.style.alertStyle) { _ in
                outcome.chose(action)
            })
        }
        alert.view.tintColor = FrameColors.tint
        if let popover = alert.popoverPresentationController {
            // iPad: an action sheet is a popover at the button that opened it.
            popover.sourceView = webView
            if let anchor = anchor {
                popover.sourceRect = webRect(anchor)
            } else {
                popover.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
        }
        presented = Presented(token: token, alert: alert, outcome: outcome)
        presenter.present(alert, animated: !reduceMotion)
    }

    /// New words for the alert showing, if it is still the one with `token`.
    func updatePresented(token: String, title: String?, message: String?) {
        guard let current = presented, current.token == token,
              let alert = current.alert, current.outcome?.answered == false else { return }
        if let title = title { alert.title = title }
        if let message = message { alert.message = message }
    }

    /// Closes the alert showing (the one with `token`, or any when nil) as no
    /// choice.
    func dismissPresented(token: String?) {
        guard let current = presented else { return }
        if let token = token, token != current.token { return }
        presented = nil
        // Answer first, so nothing that happens while it slides away can.
        current.outcome?.cancel()
        if let alert = current.alert, alert.presentingViewController != nil, !alert.isBeingDismissed {
            alert.dismiss(animated: !reduceMotion)
        }
    }

    // MARK: - Form sheets (NativeChrome `presentForm`)

    /// Shows a web form as a native sheet and calls `completion` once: with
    /// the values on its submit button, or nil any other way
    /// (NativeFormSheetModel.swift). Unlike an alert, a form is not closed
    /// when the app goes to the background: what was typed stays.
    func presentForm(_ request: FormSheetRequest, token: String, retried: Bool = false,
                     completion: @escaping ([String: Any]?) -> Void) {
        // One at a time: an alert or another form showing ends as no answer.
        dismissPresented(token: nil)
        dismissForm(token: nil)

        guard let presenter = topPresenter() else {
            completion(nil)
            return
        }
        if presenter.presentedViewController?.isBeingDismissed == true {
            guard !retried else {
                completion(nil)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                guard let self = self else { return completion(nil) }
                self.presentForm(request, token: token, retried: true, completion: completion)
            }
            return
        }
        let sheet = FormSheetController(
            request: request, token: token, outcome: FormSheetOutcome(completion: completion))
        formSheet = sheet
        presenter.present(sheet, animated: !reduceMotion)
    }

    /// Closes the form sheet showing (the one with `token`, or any when nil)
    /// with no values.
    func dismissForm(token: String?) {
        guard let sheet = formSheet else { return }
        if let token = token, token != sheet.token { return }
        formSheet = nil
        sheet.close(animated: !reduceMotion)
    }

    /// The form sheet showing, for the simulator tour.
    var visibleFormSheet: FormSheetController? { formSheet }

    /// The controller to present from: the host, or whatever it is already
    /// presenting (a share sheet, the print sheet).
    private func topPresenter() -> UIViewController? {
        guard var top = host else { return nil }
        while let next = top.presentedViewController, !next.isBeingDismissed {
            top = next
        }
        return top
    }

    /// A rectangle in the page's viewport (CSS pixels from getBoundingClientRect)
    /// in the web view's own coordinates. Measured in the simulator, under the
    /// navigation bar and with the large title both open and collapsed: they
    /// are the same, so no inset is added (adding the bar's height put the
    /// popover's arrow 116 points below the button).
    private func webRect(_ rect: CGRect) -> CGRect {
        rect
    }
}

extension PresentActionStyle {
    var alertStyle: UIAlertAction.Style {
        switch self {
        case .default: return .default
        case .destructive: return .destructive
        case .cancel: return .cancel
        }
    }
}
