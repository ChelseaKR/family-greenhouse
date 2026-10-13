package net.familygreenhouse.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import net.familygreenhouse.app.MainActivity
import net.familygreenhouse.app.R
import java.util.Locale

/**
 * Draws a reminder (ReminderMessage.kt) as an Android notification: the
 * title and body the backend wrote, the badge count, and for a reminder
 * about exactly one task, Done and Snooze buttons, the same two iOS shows
 * (ios/App/App/AppDelegate.swift).
 *
 * A tap or a button opens the app on an intent NativePushActionsPlugin.kt
 * reads, which hands `{ actionId, data }` to the web
 * (frontend/src/services/nativePush.ts). The web posts Done or Snooze to the
 * task's own endpoint with the stored session, exactly as for an iOS action,
 * and the server decides. Unlike iOS, the app comes to the front to act: the
 * session lives in the web layer, and a button that acted without it would
 * need a credential in the notification.
 */
object ReminderNotifications {
    const val CHANNEL_ID = "care_reminders"

    const val EXTRA_ACTION = "net.familygreenhouse.app.push.ACTION"
    const val EXTRA_DATA = "net.familygreenhouse.app.push.DATA"
    const val EXTRA_TAG = "net.familygreenhouse.app.push.TAG"
    const val EXTRA_ID = "net.familygreenhouse.app.push.ID"

    private fun language(): String = Locale.getDefault().language

    /** Creates the channel once; the system keeps the person's choices for it. */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            ReminderMessage.channelName(language()),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply { setShowBadge(true) }
        manager.createNotificationChannel(channel)
    }

    /** Shows the reminder. False when notifications are not allowed for the app. */
    fun show(context: Context, message: ReminderMessage, messageId: String?): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        ensureChannel(context)
        val id = ReminderMessage.notificationId(message.tag, messageId)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setColor(ContextCompat.getColor(context, R.color.fg_notification_accent))
            .setContentTitle(message.title)
            .setContentText(message.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message.body))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open(context, ReminderMessage.ACTION_TAP, message, id))
        message.badge?.let { builder.setNumber(it) }
        message.task?.let { task ->
            builder.addAction(0, task.doneLabel, open(context, ReminderMessage.ACTION_DONE, message, id))
            builder.addAction(0, task.snoozeLabel, open(context, ReminderMessage.ACTION_SNOOZE, message, id))
        }
        NotificationManagerCompat.from(context).notify(message.tag, id, builder.build())
        return true
    }

    /** Takes a reminder down once a button on it has been acted on. */
    fun cancel(context: Context, tag: String?, id: Int) {
        NotificationManagerCompat.from(context).cancel(tag, id)
    }

    private fun open(context: Context, action: String, message: ReminderMessage, id: Int): PendingIntent {
        val data = Bundle().apply { message.webData().forEach { (k, v) -> putString(k, v) } }
        val intent = Intent(context, MainActivity::class.java).apply {
            // A distinct action per button, so the three PendingIntents are three.
            this.action = "net.familygreenhouse.app.push.$action"
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_ACTION, action)
            putExtra(EXTRA_DATA, data)
            putExtra(EXTRA_TAG, message.tag)
            putExtra(EXTRA_ID, id)
        }
        val requestCode = 31 * id + action.hashCode()
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
