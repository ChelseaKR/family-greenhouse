package net.familygreenhouse.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The data message backend/src/services/fcmNotifier.ts `messageBody` sends. */
class ReminderMessageTest {
    private val oneTask = mapOf(
        "kind" to "fg.reminder.v1",
        "title" to "Water the Monstera",
        "body" to "Due today.",
        "url" to "https://familygreenhouse.net/plants/p1?task=t1#care",
        "tag" to "reminder-p1",
        "badge" to "1",
        "taskId" to "t1",
        "plantId" to "p1",
        "expectedNextDue" to "2026-06-01T08:00:00.000Z",
        "doneLabel" to "Hecho",
        "snoozeLabel" to "Posponer hasta mañana",
    )

    @Test
    fun `a one-task reminder gets its words, badge and both buttons with the sent labels`() {
        val message = ReminderMessage.parse(oneTask, "en")!!
        assertEquals("Water the Monstera", message.title)
        assertEquals("Due today.", message.body)
        assertEquals(1, message.badge)
        assertEquals("reminder-p1", message.tag)
        val task = message.task!!
        assertEquals("t1", task.taskId)
        assertEquals("Hecho", task.doneLabel)
        assertEquals("Posponer hasta mañana", task.snoozeLabel)
        assertEquals(
            mapOf(
                "url" to "https://familygreenhouse.net/plants/p1?task=t1#care",
                "taskId" to "t1",
                "plantId" to "p1",
                "expectedNextDue" to "2026-06-01T08:00:00.000Z",
            ),
            message.webData(),
        )
    }

    @Test
    fun `labels fall back to the device language, the same words as iOS`() {
        val bare = oneTask - "doneLabel" - "snoozeLabel"
        assertEquals("Done", ReminderMessage.parse(bare, "en")!!.task!!.doneLabel)
        assertEquals("Snooze until tomorrow", ReminderMessage.parse(bare, "en")!!.task!!.snoozeLabel)
        assertEquals("Hecho", ReminderMessage.parse(bare, "es")!!.task!!.doneLabel)
        assertEquals("Recordatorios de cuidado", ReminderMessage.channelName("es"))
        assertEquals("Care reminders", ReminderMessage.channelName("en"))
    }

    @Test
    fun `several tasks, or a task without both ids, get no buttons`() {
        assertNull(ReminderMessage.parse(oneTask - "taskId" - "plantId", "en")!!.task)
        assertNull(ReminderMessage.parse(oneTask - "plantId", "en")!!.task)
    }

    @Test
    fun `only this kind with a title is drawn`() {
        assertNull(ReminderMessage.parse(oneTask - "kind", "en"))
        assertNull(ReminderMessage.parse(oneTask + ("kind" to "fg.reminder.v2"), "en"))
        assertNull(ReminderMessage.parse(oneTask + ("title" to " "), "en"))
    }

    @Test
    fun `a bad badge is no badge, and a negative one is zero`() {
        assertNull(ReminderMessage.parse(oneTask + ("badge" to "x"), "en")!!.badge)
        assertEquals(0, ReminderMessage.parse(oneTask + ("badge" to "-2"), "en")!!.badge)
    }

    @Test
    fun `one notification per tag, so a newer reminder replaces an older one`() {
        assertEquals(ReminderMessage.notificationId("reminder-p1", "m1"), ReminderMessage.notificationId("reminder-p1", "m2"))
        assertNotEquals(ReminderMessage.notificationId(null, "m1"), ReminderMessage.notificationId(null, "m2"))
    }

    @Test
    fun `the action ids are the web's and iOS's`() {
        assertEquals(listOf("tap", "done", "snooze"), listOf(ReminderMessage.ACTION_TAP, ReminderMessage.ACTION_DONE, ReminderMessage.ACTION_SNOOZE))
    }
}
