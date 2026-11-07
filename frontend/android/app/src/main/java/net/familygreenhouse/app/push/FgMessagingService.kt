package net.familygreenhouse.app.push

import com.capacitorjs.plugins.pushnotifications.MessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.Locale

/**
 * The app's Firebase messaging service, in place of the Capacitor push
 * plugin's own (AndroidManifest.xml removes that one and declares this).
 *
 * The backend sends reminders as data messages (fcmNotifier.ts), which FCM
 * never draws, so this draws them, with Done and Snooze for a single task
 * (ReminderNotifications.kt). Then it hands the message to the Capacitor
 * plugin as before, which reports it to the web as received and keeps
 * registration tokens flowing (`onNewToken` is the plugin's, unchanged).
 *
 * It runs only in a build carrying google-services.json, where Firebase
 * starts; without one, nothing calls it.
 */
class FgMessagingService : MessagingService() {
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        ReminderMessage.parse(remoteMessage.data, Locale.getDefault().language)?.let { message ->
            ReminderNotifications.show(applicationContext, message, remoteMessage.messageId)
        }
        super.onMessageReceived(remoteMessage)
    }
}
