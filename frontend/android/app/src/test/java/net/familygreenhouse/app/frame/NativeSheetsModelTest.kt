package net.familygreenhouse.app.frame

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rules NativePresentModel.swift and NativeFormSheetModel.swift keep on iOS. */
class NativeSheetsModelTest {
    private fun action(id: String, style: String) = mapOf("id" to id, "title" to id.uppercase(), "style" to style)

    @Test
    fun `an alert needs exactly one cancel and one other action`() {
        val ok = PresentRequest.parse("alert", "Delete?", null, listOf(action("go", "destructive"), action("no", "cancel")))
        assertNotNull(ok.value)
        assertEquals("exactly one cancel action", PresentRequest.parse("alert", "t", null, listOf(action("go", "default"))).error)
        assertEquals(
            "exactly one cancel action",
            PresentRequest.parse("alert", "t", null, listOf(action("a", "cancel"), action("b", "cancel"))).error,
        )
        assertEquals("at least one action besides cancel", PresentRequest.parse("actionSheet", null, null, listOf(action("a", "cancel"))).error)
        assertEquals("an alert needs a title or a message", PresentRequest.parse("alert", " ", null, listOf(action("a", "cancel"))).error)
        assertEquals("action ids must be unique", PresentRequest.parse("alert", "t", null, listOf(action("a", "default"), action("a", "cancel"))).error)
        assertEquals("kind must be alert or actionSheet", PresentRequest.parse("toast", "t", null, emptyList()).error)
    }

    @Test
    fun `only a tap on a non-cancel button is a choice, and nothing answers twice`() {
        val request = PresentRequest.parse("alert", "t", null, listOf(action("go", "default"), action("no", "cancel"))).value!!
        val answers = mutableListOf<String?>()
        val outcome = PresentOutcome { answers.add(it) }
        outcome.chose(request.cancelAction)
        outcome.chose(request.choices.first())
        outcome.cancel()
        assertEquals(listOf<String?>(null), answers)

        val chosen = mutableListOf<String?>()
        val second = PresentOutcome { chosen.add(it) }
        second.chose(request.choices.first())
        second.cancel()
        assertEquals(listOf<String?>("go"), chosen)
    }

    private val addTask = mapOf(
        "title" to "Add care task",
        "cancel" to "Cancel",
        "submit" to "Add",
        "fields" to listOf(
            mapOf(
                "kind" to "choice", "id" to "type", "label" to "Task", "value" to "water",
                "options" to listOf(mapOf("id" to "water", "title" to "Water"), mapOf("id" to "custom", "title" to "Custom")),
            ),
            mapOf(
                "kind" to "text", "id" to "customType", "label" to "Name", "value" to "", "required" to true,
                "maxLength" to 50, "visibleWhen" to mapOf("field" to "type", "equals" to "custom"),
            ),
            mapOf(
                "kind" to "stepper", "id" to "frequency", "label" to "How often", "value" to 7, "min" to 1, "max" to 365,
                "one" to "Every day", "other" to "Every {n} days",
            ),
            mapOf("kind" to "text", "id" to "notes", "label" to "Notes", "value" to "", "multiline" to true),
        ),
    )

    @Test
    fun `a form submits only with every shown required field filled, and only shown fields`() {
        val request = FormSheetRequest.parse(addTask).value!!
        var values = request.initialValues
        assertTrue(request.canSubmit(values))
        assertEquals(mapOf("type" to "water", "frequency" to 7, "notes" to ""), request.submitted(values))

        values = values + ("type" to FormSheetValue.Words("custom"))
        assertFalse(request.canSubmit(values))
        val answers = mutableListOf<Map<String, Any>?>()
        val outcome = FormSheetOutcome { answers.add(it) }
        outcome.submit(request, values)
        assertTrue(answers.isEmpty())

        values = values + ("customType" to FormSheetValue.Words("Mist leaves"))
        outcome.submit(request, values)
        outcome.cancel()
        assertEquals(1, answers.size)
        assertEquals("Mist leaves", answers[0]!!["customType"])
    }

    @Test
    fun `a dismissed form answers no values`() {
        val answers = mutableListOf<Map<String, Any>?>()
        val outcome = FormSheetOutcome { answers.add(it) }
        outcome.cancel()
        outcome.submit(FormSheetRequest.parse(addTask).value!!, FormSheetRequest.parse(addTask).value!!.initialValues)
        assertEquals(listOf<Map<String, Any>?>(null), answers)
    }

    @Test
    fun `a malformed form is refused, never drawn half right`() {
        assertEquals("a form sheet needs a title, cancel and submit", FormSheetRequest.parse(addTask - "submit").error)
        val badCondition = addTask + ("fields" to listOf(
            mapOf("kind" to "text", "id" to "a", "label" to "A", "visibleWhen" to mapOf("field" to "nope", "equals" to "x")),
        ))
        assertEquals("visibleWhen names no field", FormSheetRequest.parse(badCondition).error)
        assertNull(FormSheetRequest.parse(addTask + ("fields" to emptyList<Any>())).value)
        assertEquals("Every 3 days", FormSheetRequest.stepperWords("Every day", "Every {n} days", 3))
        assertEquals("Every day", FormSheetRequest.stepperWords("Every day", "Every {n} days", 1))
    }

    @Test
    fun `bar tools report only ids the web sent, and an identical send changes nothing`() {
        val tools = BarTools.parse(
            "/plants",
            listOf(
                mapOf(
                    "id" to "filter", "label" to "Filter", "symbol" to "line.3.horizontal.decrease.circle",
                    "groups" to listOf(mapOf("title" to "Show", "items" to listOf(
                        mapOf("id" to "mine", "label" to "Only mine", "checked" to false),
                        mapOf("id" to "", "label" to "dropped"),
                    ))),
                ),
                mapOf("id" to "empty", "label" to "x", "symbol" to "y", "groups" to emptyList<Any>()),
            ),
            mapOf("placeholder" to "Search plants", "text" to ""),
        )!!
        assertEquals(1, tools.menus.size)
        assertTrue(tools.offers("mine"))
        assertFalse(tools.offers("water"))
        assertTrue(tools.reshapesList("mine"))
        assertNull(BarTools.parse(null, null, null))

        val store = BarToolsStore()
        assertTrue(store.set(tools))
        assertFalse(store.set(tools))
        assertTrue(store.set(BarTools("/plants", emptyList(), null)))
        assertNull(store.tools("/plants"))

        val echo = SearchEcho()
        echo.webSet("fern")
        assertNull(echo.userTyped("fern"))
        assertEquals("fer", echo.userTyped("fer"))
    }
}
