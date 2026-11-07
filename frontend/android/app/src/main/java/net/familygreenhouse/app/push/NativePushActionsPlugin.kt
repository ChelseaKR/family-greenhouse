package net.familygreenhouse.app.push

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Hands a tap or a Done / Snooze button on a reminder
 * (ReminderNotifications.kt) to the web, as the event `pushAction`:
 * `{ actionId: "tap" | "done" | "snooze", data: { url?, taskId?, plantId?,
 * expectedNextDue? } }`. The same ids and fields iOS reports through
 * `pushNotificationActionPerformed` (frontend/src/services/pushActions.ts),
 * so the web acts on both the same way.
 *
 * The event is retained until the web's listener is attached, so a button
 * that started the app is acted on once the page is up. The web listens only
 * when `Capacitor.PluginHeaders` lists this plugin (lib/platform.ts); a build
 * without it keeps the Capacitor plugin's own tap handling. No methods: it
 * only reports. MainActivity registers it.
 */
@CapacitorPlugin(name = "NativePushActions")
class NativePushActionsPlugin : Plugin() {
    override fun load() {
        // A button or a tap that launched the app.
        activity?.intent?.let { handle(it) }
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent) {
        val action = intent.getStringExtra(ReminderNotifications.EXTRA_ACTION) ?: return
        val data = JSObject()
        intent.getBundleExtra(ReminderNotifications.EXTRA_DATA)?.let { bundle: Bundle ->
            for (key in bundle.keySet()) bundle.getString(key)?.let { data.put(key, it) }
        }
        if (action != ReminderMessage.ACTION_TAP) {
            // The tap's notification cancels itself; a button's does not.
            ReminderNotifications.cancel(
                context,
                intent.getStringExtra(ReminderNotifications.EXTRA_TAG),
                intent.getIntExtra(ReminderNotifications.EXTRA_ID, 0),
            )
        }
        // Consumed: a recreated activity must not act on it again.
        intent.removeExtra(ReminderNotifications.EXTRA_ACTION)
        notifyListeners("pushAction", JSObject().put("actionId", action).put("data", data), true)
    }
}
