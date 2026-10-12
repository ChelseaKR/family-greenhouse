package net.familygreenhouse.app

import android.os.Bundle
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.BridgeActivity
import net.familygreenhouse.app.frame.NativeChromePlugin
import net.familygreenhouse.app.frame.NativeFrameController
import net.familygreenhouse.app.intro.NativeIntroPlugin

/**
 * Capacitor's bridge activity, plus the plugins that live in this app rather
 * than in an npm package (docs/mobile.md, "Native capabilities": the
 * app-target table; `npm run mobile:validate` holds that table to the
 * `@CapacitorPlugin` classes here and to the registrations below).
 *
 * Each is registered before the bridge loads the page, so the bridge lists it
 * in `Capacitor.PluginHeaders` at the first paint and the web knows the
 * native surface is there (lib/platform.ts). An unregistered plugin is never
 * driven from the web: the web asks for its header first.
 */
class MainActivity : BridgeActivity() {
    private var frame: NativeFrameController? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(NativeChromePlugin::class.java)
        registerPlugin(NativeIntroPlugin::class.java)

        // The frame's back callback goes in BEFORE the bridge: callbacks added
        // later win, and @capacitor/app's (added when its plugin loads) must
        // win while a web dialog is open, so it closes first.
        val placeholder = BackHolder()
        onBackPressedDispatcher.addCallback(placeholder.callback)

        super.onCreate(savedInstanceState)

        val bridge = bridge ?: return
        val controller = NativeFrameController(this, bridge.webView)
        controller.install()
        placeholder.target = controller
        (bridge.getPlugin("NativeChrome")?.instance as? NativeChromePlugin)?.let { plugin ->
            plugin.frame = controller
            controller.events = plugin
        }
        frame = controller
    }

    override fun onDestroy() {
        frame?.destroy()
        super.onDestroy()
    }

    /**
     * Holds the dispatcher's place for the frame's back handling until the
     * frame exists, and forwards to it from then on. Off until the frame
     * says back stays inside the app.
     */
    private class BackHolder {
        var target: NativeFrameController? = null
            set(value) {
                field = value
                value?.onBackEnabledChange = { enabled -> callback.isEnabled = enabled }
            }

        val callback = object : OnBackPressedCallback(false) {
            override fun handleOnBackStarted(backEvent: BackEventCompat) {
                target?.backStarted()
            }

            override fun handleOnBackProgressed(backEvent: BackEventCompat) {
                target?.backProgressed(backEvent)
            }

            override fun handleOnBackCancelled() {
                target?.backCancelled()
            }

            override fun handleOnBackPressed() {
                target?.goBack()
            }
        }
    }
}
