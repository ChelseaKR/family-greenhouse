package net.familygreenhouse.app.push

/**
 * A reminder as the backend sends it to Android: an FCM data message
 * (backend/src/services/fcmNotifier.ts `messageBody`), every value a string.
 * Plain Kotlin with no Android types, so it runs as a JVM unit test
 * (ReminderMessageTest.kt); ReminderNotifications.kt draws it.
 *
 * Only a message of [KIND] is drawn. Anything else (another sender, a later
 * format this build does not know) is left alone, and the Capacitor push
 * plugin still reports it to the web as received.
 */
data class ReminderMessage(
    val title: String,
    val body: String,
    /** The deep link a tap opens; only this site's own links are followed (the web checks). */
    val url: String?,
    /** A newer reminder with the same tag replaces an unread older one. */
    val tag: String?,
    /** The launcher's badge or dot count, where the launcher shows one. */
    val badge: Int?,
    /** The one task the reminder is about, which gets Done and Snooze; null for several. */
    val task: Task?,
) {
    data class Task(
        val taskId: String,
        val plantId: String,
        val expectedNextDue: String?,
        /** The button labels, in the recipient's language. */
        val doneLabel: String,
        val snoozeLabel: String,
    )

    /** The fields the web reads when a notification is tapped or a button pressed. */
    fun webData(): Map<String, String> = buildMap {
        url?.let { put("url", it) }
        task?.let {
            put("taskId", it.taskId)
            put("plantId", it.plantId)
            it.expectedNextDue?.let { due -> put("expectedNextDue", due) }
        }
    }

    companion object {
        /** `ANDROID_REMINDER_KIND` in fcmNotifier.ts. */
        const val KIND = "fg.reminder.v1"

        /** The action ids, as iOS's category and the web name them (pushActions.ts). */
        const val ACTION_TAP = "tap"
        const val ACTION_DONE = "done"
        const val ACTION_SNOOZE = "snooze"

        /**
         * Reads a data message. Null when it is not a reminder this build
         * draws. A task without both ids gets no buttons, rather than buttons
         * that cannot act.
         */
        fun parse(data: Map<String, String>, language: String): ReminderMessage? {
            if (data["kind"] != KIND) return null
            val title = data["title"]?.takeIf { it.isNotBlank() } ?: return null
            val taskId = data["taskId"]?.takeIf { it.isNotBlank() }
            val plantId = data["plantId"]?.takeIf { it.isNotBlank() }
            val fallback = fallbackLabels(language)
            val task = if (taskId != null && plantId != null) {
                Task(
                    taskId = taskId,
                    plantId = plantId,
                    expectedNextDue = data["expectedNextDue"]?.takeIf { it.isNotBlank() },
                    doneLabel = data["doneLabel"]?.takeIf { it.isNotBlank() } ?: fallback.first,
                    snoozeLabel = data["snoozeLabel"]?.takeIf { it.isNotBlank() } ?: fallback.second,
                )
            } else {
                null
            }
            return ReminderMessage(
                title = title,
                body = data["body"] ?: "",
                url = data["url"]?.takeIf { it.isNotBlank() },
                tag = data["tag"]?.takeIf { it.isNotBlank() },
                badge = data["badge"]?.toIntOrNull()?.coerceAtLeast(0),
                task = task,
            )
        }

        /**
         * The labels when the message carries none: the device's language,
         * the same words as iOS's `reminderActionTitles()` and the backend's
         * `reminderActionCopy`.
         */
        fun fallbackLabels(language: String): Pair<String, String> =
            if (language.lowercase().startsWith("es")) {
                "Hecho" to "Posponer hasta mañana"
            } else {
                "Done" to "Snooze until tomorrow"
            }

        /** The channel's name in Settings → Notifications, in the device's language. */
        fun channelName(language: String): String =
            if (language.lowercase().startsWith("es")) "Recordatorios de cuidado" else "Care reminders"

        /**
         * The notification's id: one per tag, so a newer reminder replaces an
         * older one with the same tag; otherwise one per message.
         */
        fun notificationId(tag: String?, messageId: String?): Int =
            (tag ?: messageId ?: "reminder").hashCode()
    }
}
