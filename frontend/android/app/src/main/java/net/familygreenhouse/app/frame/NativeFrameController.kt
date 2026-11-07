package net.familygreenhouse.app.frame

import android.animation.ValueAnimator
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** A presented alert or action sheet, while it shows. */
class PresentedAlert(val token: String, val request: PresentRequest, val outcome: PresentOutcome) {
    var title by mutableStateOf(request.title)
    var message by mutableStateOf(request.message)
}

/** A presented form sheet, while it shows. */
class PresentedForm(val token: String, val request: FormSheetRequest, val outcome: FormSheetOutcome) {
    var values by mutableStateOf(request.initialValues)
}

/** What the Compose surfaces draw. Every field is snapshot state. */
class FrameUiState {
    var chromeVisible by mutableStateOf(false)
    var configuration by mutableStateOf<FrameConfiguration?>(null)
    var selectedTab by mutableStateOf<String?>(null)
    var top by mutableStateOf<FrameEntry?>(null)
    var depth by mutableStateOf(0)
    var barTools by mutableStateOf<BarTools?>(null)
    var searchOpen by mutableStateOf(false)
    var searchText by mutableStateOf("")
    var alert by mutableStateOf<PresentedAlert?>(null)
    var form by mutableStateOf<PresentedForm?>(null)
    var signOut by mutableStateOf<MoreItem?>(null)

    /** The native list showing in place of the page (More, Settings), or null. */
    val nativeList: Pair<String, List<MoreSection>>?
        get() {
            val entry = top ?: return null
            val config = configuration ?: return null
            if (!entry.isNativeList) return null
            return if (entry.path.isEmpty()) config.moreTitle to config.moreSections
            else if (entry.path == FrameConfiguration.SETTINGS_LIST_PATH) config.settingsTitle to config.settingsSections
            else null
        }
}

/** Events for the web, sent by NativeChromePlugin. */
interface FrameEvents {
    fun tabSelect(tab: String, path: String?, reselect: Boolean)
    fun back(path: String)
    fun moreSelect(id: String, path: String?)
    fun rightButton(id: String)
    fun barMenuSelect(path: String, id: String)
    fun barSearch(path: String, text: String)
}

/**
 * The Android app's native frame: Material 3's top app bar and navigation bar
 * around the ONE web view, the More and Settings lists in place of the page,
 * and alerts, action sheets and form sheets over it. The Android counterpart
 * of ios/App/App/NativeFrameController.swift, with the same model
 * (NativeFrameModel.kt) deciding every back stack.
 *
 * Unlike the iOS frame, the web view does not move between screens: Android's
 * bars do not slide whole screens, so the page stays in one place between
 * the two bars and changes under a Material transition (fade through between
 * tabs, a short slide forward and back within one).
 */
class NativeFrameController(
    private val activity: ComponentActivity,
    private val webView: WebView,
) {
    val ui = FrameUiState()
    var events: FrameEvents? = null
    private val history = TabHistory()
    private var waiting = mutableListOf<FrameReport>()
    private val barToolsStore = BarToolsStore()
    private val searchEcho = SearchEcho()
    private val scrollPositions = mutableMapOf<String, Int>()
    private var restoreScrollFor: String? = null

    private lateinit var topBar: ComposeView
    private lateinit var bottomBar: ComposeView
    private lateinit var listOverlay: ComposeView

    /**
     * Back, owned natively wherever the web has nothing open on top of the
     * page. MainActivity adds the callback that forwards here BEFORE the
     * bridge loads its plugins, so the @capacitor/app callback (added at
     * start) is ahead of it: that one is on only while a web dialog, menu or
     * the drawer is open (nativeBackButtonHandler.ts), and closes it first.
     * This one is on only when back stays inside the app, so the system
     * animates a back that leaves (predictive back to home).
     */
    var onBackEnabledChange: ((Boolean) -> Unit)? = null
        set(value) {
            field = value
            value?.invoke(backEnabled)
        }
    private var backEnabled = false

    fun backStarted() = previewBack(0f)
    fun backProgressed(event: BackEventCompat) = previewBack(event.progress)
    fun backCancelled() = previewBack(0f, animate = true)

    /** Replaces Capacitor's layout (a CoordinatorLayout holding the web view)
     *  with the bars around the web view and a list layer over it. */
    fun install() {
        val parent = webView.parent as ViewGroup
        val index = parent.indexOfChild(webView)
        parent.removeView(webView)

        val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        topBar = composeView { FrameTopBar(ui, this@NativeFrameController) }
        bottomBar = composeView { FrameBottomBar(ui, this@NativeFrameController) }
        listOverlay = composeView { FrameListLayer(ui, this@NativeFrameController) }
        val dialogs = composeView { FrameDialogs(ui, this@NativeFrameController) }

        val host = FrameLayout(activity)
        host.addView(webView, FrameLayout.LayoutParams(MATCH, MATCH))
        host.addView(listOverlay, FrameLayout.LayoutParams(MATCH, MATCH))
        listOverlay.visibility = View.GONE

        column.addView(topBar, LinearLayout.LayoutParams(MATCH, WRAP))
        column.addView(host, LinearLayout.LayoutParams(MATCH, 0, 1f))
        column.addView(bottomBar, LinearLayout.LayoutParams(MATCH, WRAP))
        // Dialogs and sheets open in their own windows; this view only hosts
        // their composition, so it takes no room and no touches.
        column.addView(dialogs, LinearLayout.LayoutParams(0, 0))
        parent.addView(column, index, ViewGroup.LayoutParams(MATCH, MATCH))

        // With the bars there, the page is between them: the status bar and
        // the gesture bar are the bars' insets, not the page's. Without them
        // (sign-in, setup), the page draws edge to edge as before and keeps
        // env(safe-area-inset-*) from the system bars.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val delivered = if (ui.chromeVisible) {
                val bars = insets.getInsets(SYSTEM_BARS)
                WindowInsetsCompat.Builder(insets)
                    .setInsets(SYSTEM_BARS, Insets.of(bars.left, 0, bars.right, 0))
                    .build()
            } else {
                insets
            }
            ViewCompat.onApplyWindowInsets(view, delivered)
        }
        setChromeVisible(false)
    }

    private fun composeView(content: @androidx.compose.runtime.Composable () -> Unit) =
        ComposeView(activity).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent { FgTheme { content() } }
        }

    // ---- From the web ----------------------------------------------------

    fun configure(configuration: FrameConfiguration) {
        ui.configuration = configuration
        history.configure(configuration.tabs, configuration.moreTitle)
        val queued = waiting
        waiting = mutableListOf()
        for (report in queued) apply(report)
        sync()
    }

    fun apply(report: FrameReport) {
        if (ui.configuration == null) {
            waiting.add(report)
            return
        }
        val before = history.top
        val change = history.apply(report)
        render(change, before)
        if (restoreScrollFor == report.path) {
            restoreScrollFor = null
            scrollPositions[report.path]?.let { restoreScroll(it) }
        }
        updateBackCallback(report)
    }

    private fun render(change: FrameChange, before: FrameEntry?) {
        when (change) {
            FrameChange.None -> Unit
            FrameChange.HideChrome -> setChromeVisible(false)
            FrameChange.RefreshTop, FrameChange.ReplaceTop -> Unit
            is FrameChange.ShowTab -> {
                setChromeVisible(true)
                transition(Transition.FADE_THROUGH)
            }
            FrameChange.Push -> {
                before?.let { saveScroll(it) }
                transition(Transition.FORWARD)
            }
            is FrameChange.Pop -> transition(Transition.BACKWARD)
        }
        sync()
    }

    /** Copies the model into the state the bars draw from. */
    private fun sync() {
        val top = history.top
        val tab = history.selected
        ui.selectedTab = tab
        ui.top = top
        ui.depth = tab?.let { history.stack(it).size } ?: 0
        val tools = top?.let { barToolsStore.tools(it.path) }
        if (tools != ui.barTools) {
            ui.barTools = tools
            val text = tools?.search?.text.orEmpty()
            searchEcho.webSet(text)
            ui.searchText = text
            ui.searchOpen = text.isNotEmpty()
        }
        val listShowing = ui.chromeVisible && ui.nativeList != null
        listOverlay.visibility = if (listShowing) View.VISIBLE else View.GONE
        // TalkBack reads the list, not the page under it.
        webView.importantForAccessibility =
            if (listShowing) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
        updateBackCallback(null)
    }

    private fun setChromeVisible(visible: Boolean) {
        if (::topBar.isInitialized && ui.chromeVisible == visible && topBar.visibility == if (visible) View.VISIBLE else View.GONE) return
        ui.chromeVisible = visible
        topBar.visibility = if (visible) View.VISIBLE else View.GONE
        bottomBar.visibility = if (visible) View.VISIBLE else View.GONE
        if (visible) {
            // The page behind the bars is paper; the forest launch color stays
            // for sign-in and setup, which draw under the status bar.
            webView.setBackgroundColor(PAPER)
        } else {
            barToolsStore.removeAll()
            scrollPositions.clear()
            ui.signOut = null
        }
        ViewCompat.requestApplyInsets(webView)
    }

    fun setBarTools(tools: BarTools) {
        if (!barToolsStore.set(tools)) return
        if (history.top?.path == tools.path) sync()
    }

    // ---- Taps --------------------------------------------------------------

    fun selectTab(tab: String) {
        history.top?.let { saveScroll(it) }
        val result = history.select(tab)
        when (val change = result.change) {
            is FrameChange.ShowTab -> {
                transition(Transition.FADE_THROUGH)
                history.top?.let { if (!it.isNativeList) restoreScrollFor = it.path }
            }
            is FrameChange.Pop -> transition(Transition.BACKWARD)
            FrameChange.None -> if (result.reselect) scrollToTop()
            else -> Unit
        }
        sync()
        events?.tabSelect(tab, result.path, result.reselect)
    }

    fun moreItemChosen(item: MoreItem) {
        val config = ui.configuration ?: return
        if (item.destructive) {
            ui.signOut = item
            return
        }
        val path = item.path
        if (path != null && path.startsWith(FrameEntry.NATIVE_LIST_PREFIX)) {
            if (history.pushNativeList(path, config.settingsTitle) == FrameChange.Push) {
                transition(Transition.FORWARD)
            }
            sync()
            return
        }
        events?.moreSelect(item.id, item.path)
    }

    fun confirmSignOut(confirmed: Boolean) {
        val item = ui.signOut ?: return
        ui.signOut = null
        if (confirmed) events?.moreSelect(item.id, item.path)
    }

    fun rightButtonTapped(id: String) {
        events?.rightButton(id)
    }

    fun barMenuPicked(id: String) {
        val path = history.top?.path ?: return
        val tools = barToolsStore.tools(path) ?: return
        if (!tools.offers(id)) return
        events?.barMenuSelect(path, id)
        if (tools.reshapesList(id)) webView.postDelayed({ scrollToTop() }, 200)
    }

    fun searchChanged(text: String) {
        ui.searchText = text
        val path = history.top?.path ?: return
        searchEcho.userTyped(text)?.let { events?.barSearch(path, it) }
    }

    fun closeSearch() {
        ui.searchOpen = false
        searchChanged("")
    }

    /** The top app bar's arrow, and Android back (via the callback). */
    fun goBack() {
        webView.animate().cancel()
        webView.translationX = 0f
        webView.alpha = 1f
        if (!ui.chromeVisible) {
            if (BackPolicy.allows(webView.url, backUrl())) webView.goBack()
            return
        }
        if (ui.searchOpen) {
            closeSearch()
            return
        }
        when (val target = history.backTarget()) {
            is BackTarget.PopTo -> {
                val path = history.didPop(target.depth)
                transition(Transition.BACKWARD)
                path?.let {
                    restoreScrollFor = it
                    events?.back(it)
                }
                sync()
            }
            is BackTarget.FirstTab -> selectTab(target.tab)
            BackTarget.Leave -> activity.moveTaskToBack(true)
        }
    }

    // ---- Alerts and sheets (NativeChrome `present` / `presentForm`) --------

    fun present(request: PresentRequest, token: String, completion: (String?) -> Unit) {
        dismissPresented(null)
        dismissForm(null)
        ui.alert = PresentedAlert(token, request, PresentOutcome(completion))
    }

    fun updatePresented(token: String, title: String?, message: String?) {
        val current = ui.alert ?: return
        if (current.token != token || current.outcome.answered) return
        title?.let { current.title = it }
        message?.let { current.message = it }
    }

    fun dismissPresented(token: String?) {
        val current = ui.alert ?: return
        if (token != null && token != current.token) return
        ui.alert = null
        current.outcome.cancel()
    }

    fun alertChose(alert: PresentedAlert, action: PresentAction?) {
        if (ui.alert === alert) ui.alert = null
        if (action == null) alert.outcome.cancel() else alert.outcome.chose(action)
    }

    fun presentForm(request: FormSheetRequest, token: String, completion: (Map<String, Any>?) -> Unit) {
        dismissPresented(null)
        dismissForm(null)
        ui.form = PresentedForm(token, request, FormSheetOutcome(completion))
    }

    fun dismissForm(token: String?) {
        val current = ui.form ?: return
        if (token != null && token != current.token) return
        ui.form = null
        current.outcome.cancel()
    }

    fun formSubmit(form: PresentedForm) {
        form.outcome.submit(form.request, form.values)
        if (form.outcome.answered && ui.form === form) ui.form = null
    }

    fun formCancel(form: PresentedForm) {
        if (ui.form === form) ui.form = null
        form.outcome.cancel()
    }

    /** The activity is going away: nothing may be left hanging. */
    fun destroy() {
        dismissPresented(null)
        dismissForm(null)
    }

    // ---- Back --------------------------------------------------------------

    private var lastReportPath: String? = null

    private fun updateBackCallback(report: FrameReport?) {
        report?.let { lastReportPath = it.path }
        val enabled = if (ui.chromeVisible) {
            ui.searchOpen || history.backTarget() != BackTarget.Leave
        } else {
            BackPolicy.allows(webView.url, backUrl())
        }
        if (enabled != backEnabled) {
            backEnabled = enabled
            onBackEnabledChange?.invoke(enabled)
        }
    }

    /** Called when the search field opens or closes. */
    fun searchVisibilityChanged() = updateBackCallback(null)

    private fun backUrl(): String? {
        val list = webView.copyBackForwardList()
        val index = list.currentIndex
        return if (index > 0) list.getItemAtIndex(index - 1)?.url else null
    }

    /** Predictive back inside the app: the page follows the gesture a little,
     *  then the back runs (or the page settles if the gesture is cancelled). */
    private fun previewBack(progress: Float, animate: Boolean = false) {
        if (!animationsOn()) return
        val shift = progress * webView.width * 0.08f
        if (animate) webView.animate().translationX(0f).alpha(1f).setDuration(150).start()
        else {
            webView.translationX = shift
            webView.alpha = 1f - progress * 0.15f
        }
    }

    // ---- Page position and motion -----------------------------------------

    private fun saveScroll(entry: FrameEntry) {
        if (!entry.isNativeList) scrollPositions[entry.path] = webView.scrollY
    }

    private fun restoreScroll(y: Int) {
        // The page renders after the route changes; try again once it settles.
        webView.postDelayed({ webView.scrollTo(0, y) }, 120)
        webView.postDelayed({ if (webView.scrollY == 0 && y > 0) webView.scrollTo(0, y) }, 450)
    }

    private fun scrollToTop() {
        webView.evaluateJavascript(
            "window.scrollTo({top: 0, behavior: ${if (animationsOn()) "'smooth'" else "'auto'"}})",
            null,
        )
    }

    private enum class Transition { FADE_THROUGH, FORWARD, BACKWARD }

    /** Material's motion for the page: fade through between tabs, a shared
     *  X axis forward and back within one. Off when animations are off
     *  (Settings → Accessibility → Remove animations). */
    private fun transition(kind: Transition) {
        webView.animate().cancel()
        webView.translationX = 0f
        webView.alpha = 1f
        webView.scaleX = 1f
        webView.scaleY = 1f
        if (!animationsOn()) return
        val distance = 30 * activity.resources.displayMetrics.density
        when (kind) {
            Transition.FADE_THROUGH -> {
                webView.alpha = 0f
                webView.scaleX = 0.96f
                webView.scaleY = 0.96f
                webView.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(210).start()
            }
            Transition.FORWARD -> {
                webView.alpha = 0f
                webView.translationX = distance
                webView.animate().alpha(1f).translationX(0f).setDuration(250).start()
            }
            Transition.BACKWARD -> {
                webView.alpha = 0f
                webView.translationX = -distance
                webView.animate().alpha(1f).translationX(0f).setDuration(250).start()
            }
        }
    }

    private fun animationsOn(): Boolean = ValueAnimator.areAnimatorsEnabled()

    companion object {
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        private val SYSTEM_BARS = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        private const val PAPER = 0xFFF7F8F2.toInt()
    }
}
