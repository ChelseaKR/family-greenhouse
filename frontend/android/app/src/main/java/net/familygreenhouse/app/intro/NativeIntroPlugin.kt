package net.familygreenhouse.app.intro

import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.core.view.WindowCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import net.familygreenhouse.app.frame.NativeChromePlugin
import org.json.JSONObject

/**
 * The signed-out intro, in Jetpack Compose, over the web's sign-in screen.
 * The same name, methods and payloads as ios/App/App/NativeIntroPlugin.swift,
 * written down once in frontend/src/config/nativeIntro.ts
 * (frontend/tests/unit/config/nativeIntro.test.ts holds both to it).
 *
 * Web -> native (answered):
 * - `present({ token, start, pages, skip, next, pagePosition, appName,
 *   tagline, create?, signIn })` shows the intro over the whole window and
 *   resolves `{ choice }`: `"create"` or `"signIn"` for the door that was
 *   tapped, or null for no choice (the web closed it, another intro replaced
 *   it, back on its first page).
 * - `dismiss({ token })`: the web left the sign-in screen first; the intro
 *   goes away and answers no choice.
 *
 * It only presents and reports. Signing in and creating an account are the
 * web's own screens, with the same requests as the website. The web asks for
 * it only when `Capacitor.PluginHeaders` lists it with both methods, so an
 * app built without it keeps the web sign-in screen. MainActivity registers it.
 */
@CapacitorPlugin(name = "NativeIntro")
class NativeIntroPlugin : Plugin() {
    private class Shown(
        val token: String,
        val session: IntroSession,
        val view: ComposeView,
        val back: OnBackPressedCallback,
        /** What each view underneath had for TalkBack, given back on close. */
        val hidden: List<Pair<View, Int>>,
    )

    private var shown: Shown? = null

    @PluginMethod
    fun present(call: PluginCall) {
        val token = call.getString("token")
        if (token.isNullOrEmpty()) {
            call.reject("present needs a token", "INVALID")
            return
        }
        val parsed = IntroRequest.parse(NativeChromePlugin.toMap(call.data))
        val request = parsed.request
        if (request == null) {
            call.reject(parsed.error ?: "invalid intro", "INVALID")
            return
        }
        bridge.executeOnMainThread {
            val activity = activity
            val content = activity?.findViewById<ViewGroup>(android.R.id.content)
            if (activity == null || content == null || activity.isFinishing) {
                call.resolve(JSObject().put("choice", JSONObject.NULL))
                return@executeOnMainThread
            }
            // One at a time: a second request replaces the first, which
            // answers no choice.
            closeShown(animated = false)

            val session = IntroSession(request) { choice ->
                call.resolve(JSObject().put("choice", choice?.wire ?: JSONObject.NULL))
            }
            val page = mutableIntStateOf(0)
            val view = ComposeView(activity).apply {
                setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
                // Over the web view and the frame: touches and TalkBack stay here.
                isClickable = true
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
                setContent {
                    IntroScreen(session = session, page = page, onFinish = { closeShown(animated = true) })
                }
            }
            // Back pages backward, then closes onto the sign-in screen. Added
            // last, so it wins over the frame's and @capacitor/app's while up.
            val back = object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val target = introBackTarget(page.intValue)
                    if (target != null) {
                        page.intValue = target
                    } else {
                        session.close()
                        closeShown(animated = true)
                    }
                }
            }
            activity.onBackPressedDispatcher.addCallback(back)

            // Dark status bar icons on the intro's Paper. Left that way after
            // it closes: the sign-in and sign-up screens under it are Paper too.
            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                .isAppearanceLightStatusBars = true

            // Everything underneath (the frame and the web view in it) is out
            // of TalkBack's reach while the intro covers it, as under a modal
            // on iOS. Set on the views around the web view, not the web view
            // itself: its own flag does not hide its page once accessibility
            // is on (measured on the emulator).
            val hidden = (0 until content.childCount).map { content.getChildAt(it) }.map { child ->
                val before = child.importantForAccessibility
                child.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                child to before
            }

            content.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
            if (animationsOn()) {
                view.alpha = 0f
                view.animate().alpha(1f).setDuration(FADE_MS).start()
            }
            shown = Shown(token, session, view, back, hidden)
        }
    }

    @PluginMethod
    fun dismiss(call: PluginCall) {
        val token = call.getString("token") ?: ""
        bridge.executeOnMainThread {
            if (shown?.token == token) closeShown(animated = true)
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        closeShown(animated = false)
        super.handleOnDestroy()
    }

    /**
     * Takes the intro down. A session that has not answered answers no
     * choice; one that has (a door was tapped) is only taken down, fading so
     * the screen the web opens underneath shows through.
     */
    private fun closeShown(animated: Boolean) {
        val current = shown ?: return
        shown = null
        current.session.close()
        current.back.remove()
        for ((child, before) in current.hidden) child.importantForAccessibility = before
        val view = current.view
        val remove = { (view.parent as? ViewGroup)?.removeView(view) }
        // The intro is gone for TalkBack at once, before the fade ends.
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        if (animated && animationsOn()) {
            view.animate().alpha(0f).setDuration(FADE_MS).withEndAction { remove() }.start()
        } else {
            remove()
        }
    }

    private fun animationsOn(): Boolean = android.animation.ValueAnimator.areAnimatorsEnabled()

    companion object {
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val FADE_MS = 280L
    }
}
