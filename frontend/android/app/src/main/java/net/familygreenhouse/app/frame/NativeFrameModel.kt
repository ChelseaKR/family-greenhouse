package net.familygreenhouse.app.frame

// The native frame's routing logic, in plain Kotlin with no Android types, so
// it runs as a local JVM test (NativeFrameModelTest). A line-for-line port of
// ios/App/App/NativeFrameModel.swift: the two apps keep the same back stacks
// for the same reports, so a route opens in the same tab, with the same way
// back, on both.
//
// The web reports every route change (`FrameReport`, from the NativeChrome
// plugin's `update`); `TabHistory` turns each report into the change the bars
// should make (`FrameChange`), and keeps each tab's back stack so a tab opens
// where it was left. The route -> tab map itself lives in the web
// (frontend/src/config/nativeFrame.ts), which sends the tab with each report;
// a report with no tab stays in the tab it was opened from.

/** A trailing top-app-bar button a screen asks for. */
data class FrameBarButton(val id: String, val symbol: String, val label: String)

/** One screen in a tab's back stack. */
data class FrameEntry(
    /** pathname + search. Empty for More's first screen, which is native;
     *  `native:<id>` for another native list pushed on a tab (Settings). */
    val path: String,
    /** React Router's location key, or "" for a screen the web never showed
     *  yet (a tab's root placed under a deep link). */
    val key: String,
    val title: String,
    val largeTitle: Boolean,
    val rightButton: FrameBarButton? = null,
) {
    /** A native list (More's first screen, or Settings), not a web page. */
    val isNativeList: Boolean get() = path.isEmpty() || path.startsWith(NATIVE_LIST_PREFIX)

    companion object {
        const val NATIVE_LIST_PREFIX = "native:"
        fun nativeList(title: String) = FrameEntry("", "", title, largeTitle = true)
    }
}

enum class FrameChrome(val raw: String) {
    TABS("tabs"), NONE("none");

    companion object {
        fun from(raw: String?): FrameChrome = entries.firstOrNull { it.raw == raw } ?: NONE
    }
}

enum class FrameNavigation(val raw: String) {
    PUSH("push"), REPLACE("replace"), POP("pop");

    companion object {
        fun from(raw: String?): FrameNavigation = entries.firstOrNull { it.raw == raw } ?: PUSH
    }
}

/** What the web sends on every route change. */
data class FrameReport(
    val path: String,
    val key: String,
    val title: String,
    val tab: String?,
    val canGoBack: Boolean,
    val largeTitle: Boolean,
    val chrome: FrameChrome,
    val navigation: FrameNavigation,
    val rightButton: FrameBarButton? = null,
)

data class FrameTab(
    val id: String,
    val title: String,
    /** The route the tab opens on; null for More (a native list). */
    val root: String?,
)

/** What the bars must do after a report or a tap. */
sealed class FrameChange {
    /** Nothing visible changes. */
    data object None : FrameChange()
    /** The top screen's title or button changed (or the web confirmed it). */
    data object RefreshTop : FrameChange()
    /** Sign-in, setup, signed out: no bars at all. */
    data object HideChrome : FrameChange()
    /** Show this tab with its whole stack as the model has it. */
    data class ShowTab(val tab: String) : FrameChange()
    /** A new screen on top of the current tab. */
    data object Push : FrameChange()
    /** Back to the screen at this depth (1 = the tab's root). */
    data class Pop(val toDepth: Int) : FrameChange()
    /** The top screen became another route in place. */
    data object ReplaceTop : FrameChange()
}

/** The answer to a tab tap. */
data class TabSelection(val change: FrameChange, val path: String?, val reselect: Boolean)

class TabHistory(tabs: List<FrameTab> = emptyList(), moreTitle: String = "") {
    var tabs: List<FrameTab> = tabs
        private set
    var moreTitle: String = moreTitle
        private set
    private val stacks = mutableMapOf<String, MutableList<FrameEntry>>()
    var selected: String? = null
        private set
    var chromeShown = false
        private set
    private var lastKey: String? = null
    private var lastPath: String? = null

    /** New labels (a language change) or a new tab set. Stacks of tabs that
     *  still exist are kept; their root screens take the new titles. */
    fun configure(tabs: List<FrameTab>, moreTitle: String) {
        this.tabs = tabs
        this.moreTitle = moreTitle
        val ids = tabs.map { it.id }.toSet()
        stacks.keys.retainAll(ids)
        for (tab in tabs) {
            val stack = stacks[tab.id] ?: continue
            if (stack.isEmpty()) continue
            if (stack[0].isNativeList && stack[0].path.isEmpty()) {
                stack[0] = stack[0].copy(title = moreTitle)
            } else if (stack[0].path == tab.root) {
                stack[0] = stack[0].copy(title = tab.title)
            }
        }
        val current = selected
        if (current != null && current !in ids) selected = tabs.firstOrNull()?.id
    }

    fun stack(tab: String): List<FrameEntry> = stacks[tab]?.toList() ?: emptyList()

    val top: FrameEntry?
        get() = selected?.let { stacks[it]?.lastOrNull() }

    fun tab(id: String): FrameTab? = tabs.firstOrNull { it.id == id }

    /** A tab's first screen. */
    fun rootEntry(id: String): FrameEntry? {
        val tab = tab(id) ?: return null
        val root = tab.root ?: return FrameEntry.nativeList(moreTitle)
        return FrameEntry(root, "", tab.title, largeTitle = true)
    }

    /** A stack for a report arriving in a tab with no history to keep: the
     *  report alone when it is the tab's root, otherwise on top of the root,
     *  so a deep link or a jump from another tab still has a way back. */
    private fun freshStack(tab: String, entry: FrameEntry, canGoBack: Boolean): MutableList<FrameEntry> {
        val root = rootEntry(tab) ?: return mutableListOf(entry)
        if (root.path == entry.path) return mutableListOf(entry)
        if (canGoBack || root.isNativeList) return mutableListOf(root, entry)
        return mutableListOf(entry)
    }

    private fun entry(report: FrameReport) = FrameEntry(
        path = report.path,
        key = report.key,
        title = report.title,
        largeTitle = report.largeTitle,
        rightButton = report.rightButton,
    )

    /** Fold a report into the stacks; returns what the bars must do. */
    fun apply(report: FrameReport): FrameChange {
        if (report.chrome == FrameChrome.NONE) {
            val wasShown = chromeShown
            reset()
            lastKey = report.key
            lastPath = report.path
            return if (wasShown) FrameChange.HideChrome else FrameChange.None
        }

        val entry = entry(report)

        // The same screen again: its title or button arrived or changed.
        // Key AND path: an entry the web pushed without React Router (a deep
        // link, nativeDeepLinks.ts) has the key "default", every time.
        if (chromeShown && report.key == lastKey && report.path == lastPath) {
            val tab = selected ?: return FrameChange.None
            val stack = stacks[tab] ?: return FrameChange.None
            val index = stack.indexOfLast { it.key == report.key && it.path == report.path }
            if (index < 0) return FrameChange.None
            val before = stack[index]
            stack[index] = before.copy(
                title = report.title,
                rightButton = report.rightButton,
                largeTitle = report.largeTitle,
            )
            return if (index == stack.size - 1 && stack[index] != before) FrameChange.RefreshTop else FrameChange.None
        }
        lastKey = report.key
        lastPath = report.path

        val first = tabs.firstOrNull()?.id ?: return FrameChange.None

        if (!chromeShown) {
            chromeShown = true
            val tab = report.tab ?: first
            selected = tab
            stacks[tab] = freshStack(tab, entry, report.canGoBack)
            return FrameChange.ShowTab(tab)
        }

        val current = selected ?: first
        val tab = report.tab ?: current

        if (tab != current) {
            selected = tab
            var stack = stacks[tab] ?: mutableListOf()
            val index = stack.indexOfLast { it.path == entry.path }
            if (index >= 0) {
                stack = stack.subList(0, index + 1).toMutableList()
                stack[index] = entry
            } else {
                stack = freshStack(tab, entry, report.canGoBack)
            }
            stacks[tab] = stack
            return FrameChange.ShowTab(tab)
        }

        var stack = stacks[tab] ?: mutableListOf()
        if (stack.isEmpty()) {
            stacks[tab] = freshStack(tab, entry, report.canGoBack)
            return FrameChange.ShowTab(tab)
        }

        // A screen already in this tab's stack: the web went back to it.
        // Everything above it goes.
        val index = stack.indexOfLast { it.path == entry.path }
        if (index >= 0) {
            val wasTop = index == stack.size - 1
            stack = stack.subList(0, index + 1).toMutableList()
            stack[index] = entry
            stacks[tab] = stack
            return if (wasTop) FrameChange.RefreshTop else FrameChange.Pop(index + 1)
        }

        // A replaced screen takes the top's place, unless the top is the
        // tab's root or a native list: neither is ever replaced away.
        val topIsRoot = stack.size == 1
        val topIsNative = stack.last().isNativeList
        if (report.navigation != FrameNavigation.PUSH && !topIsRoot && !topIsNative) {
            stack[stack.size - 1] = entry
            return FrameChange.ReplaceTop
        }

        stack.add(entry)
        return FrameChange.Push
    }

    /** A tab was tapped. Returns the change, the route the web should show
     *  (null for More's native list, or when nothing changes), and whether it
     *  was the tab already showing. */
    fun select(tab: String): TabSelection {
        if (tab(tab) == null) return TabSelection(FrameChange.None, null, false)
        if (tab == selected) {
            val stack = stacks[tab] ?: mutableListOf()
            // The current tab again pops to its root; at the root the
            // controller scrolls the page to the top (on `None`).
            if (stack.size > 1) {
                val root = stack[0]
                stacks[tab] = mutableListOf(root)
                return TabSelection(FrameChange.Pop(1), if (root.isNativeList) null else root.path, true)
            }
            return TabSelection(FrameChange.None, null, true)
        }
        selected = tab
        if (stacks[tab].isNullOrEmpty()) {
            rootEntry(tab)?.let { stacks[tab] = mutableListOf(it) }
        }
        val top = stacks[tab]?.lastOrNull() ?: return TabSelection(FrameChange.ShowTab(tab), null, false)
        return TabSelection(FrameChange.ShowTab(tab), if (top.isNativeList) null else top.path, false)
    }

    /** A native list (`native:<id>`) pushed on the current tab from a row of
     *  the list showing (More -> Settings). The web is not told. */
    fun pushNativeList(path: String, title: String): FrameChange {
        if (!path.startsWith(FrameEntry.NATIVE_LIST_PREFIX)) return FrameChange.None
        val tab = selected ?: return FrameChange.None
        val stack = stacks[tab] ?: return FrameChange.None
        if (stack.isEmpty()) return FrameChange.None
        if (stack.last().path == path) return FrameChange.None
        stack.add(FrameEntry(path, "", title, largeTitle = false))
        return FrameChange.Push
    }

    /** Back (the button, the gesture, or the top bar's arrow) left `depth`
     *  screens in the current tab. Returns the route the web should show,
     *  or null for a native list (or when nothing could be popped). */
    fun didPop(toDepth: Int): String? {
        val tab = selected ?: return null
        val stack = stacks[tab] ?: return null
        if (toDepth < 1 || toDepth >= stack.size) return null
        val kept = stack.subList(0, toDepth).toMutableList()
        stacks[tab] = kept
        val top = kept[toDepth - 1]
        return if (top.isNativeList) null else top.path
    }

    /** Signed out, or back to sign-in or setup: every tab starts afresh. */
    fun reset() {
        stacks.clear()
        selected = null
        chromeShown = false
    }

    /**
     * Where Android back goes from here (the system's own decision once the
     * app stops intercepting it). Not in the Swift model: iOS has no back
     * button. In Material's order:
     * - a screen above the tab's first one: back down this tab's stack;
     * - a tab's first screen that is not the first tab's: to the first tab
     *   (Home), Android's rule for a bottom navigation bar;
     * - Home's first screen: out of the app, which the system animates
     *   (predictive back), so the frame does not intercept it.
     */
    fun backTarget(): BackTarget {
        if (!chromeShown) return BackTarget.Leave
        val tab = selected ?: return BackTarget.Leave
        val depth = stacks[tab]?.size ?: 0
        if (depth > 1) return BackTarget.PopTo(depth - 1)
        val first = tabs.firstOrNull()?.id ?: return BackTarget.Leave
        return if (tab != first) BackTarget.FirstTab(first) else BackTarget.Leave
    }
}

sealed class BackTarget {
    data class PopTo(val depth: Int) : BackTarget()
    data class FirstTab(val tab: String) : BackTarget()
    data object Leave : BackTarget()
}
