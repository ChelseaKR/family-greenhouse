package net.familygreenhouse.app.intro

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rules NativeIntroModel.swift keeps on iOS. */
class NativeIntroModelTest {
    private fun page(id: String) = mapOf("id" to id, "title" to "T $id", "body" to "B $id")

    private fun raw(vararg overrides: Pair<String, Any?>): Map<String, Any?> = linkedMapOf<String, Any?>(
        "token" to "intro-1",
        "start" to "story",
        "pages" to listOf(page("household"), page("claim"), page("away"), page("start")),
        "skip" to "Skip",
        "next" to "Next",
        "pagePosition" to "Page {n} of {total}",
        "appName" to "Family Greenhouse",
        "tagline" to "Care, shared",
        "create" to "Create account",
        "signIn" to "I already have an account",
    ).apply { overrides.forEach { (k, v) -> put(k, v) } }

    @Test
    fun `reads every field the web sends`() {
        val request = IntroRequest.parse(raw()).request!!
        assertEquals(IntroStart.STORY, request.start)
        assertEquals(listOf("household", "claim", "away", "start"), request.pages.map { it.id })
        assertEquals("Create account", request.create)
        assertEquals("I already have an account", request.signIn)
        assertEquals("Family Greenhouse", request.appName)
        assertEquals("Care, shared", request.tagline)
        assertEquals("Page 2 of 4", request.position(1))
    }

    @Test
    fun `refuses an intro with a missing word, a bad start, or no pages`() {
        assertEquals("start must be story or final", IntroRequest.parse(raw("start" to "middle")).error)
        assertEquals("an intro needs at least one page", IntroRequest.parse(raw("pages" to emptyList<Any>())).error)
        assertEquals(
            "an intro needs at least one page",
            IntroRequest.parse(raw("pages" to listOf(mapOf("id" to "x", "title" to "")))).error,
        )
        assertEquals("signIn is required", IntroRequest.parse(raw("signIn" to "")).error)
        assertEquals("skip, next and pagePosition are required", IntroRequest.parse(raw("next" to null)).error)
        // A missing create is registration paused, not an error.
        assertNull(IntroRequest.parse(raw("create" to null)).request!!.create)
    }

    @Test
    fun `final shows only the last page, which is the one with the doors`() {
        val story = IntroRequest.parse(raw()).request!!
        assertEquals(4, story.shownPages.size)
        assertFalse(story.isLast(2))
        assertTrue(story.isLast(3))
        val final = IntroRequest.parse(raw("start" to "final")).request!!
        assertEquals(listOf("start"), final.shownPages.map { it.id })
        assertTrue(final.isLast(0))
        assertEquals("Page 1 of 1", final.position(0))
    }

    @Test
    fun `only a door that was offered is a choice, and nothing answers twice`() {
        val answers = mutableListOf<IntroChoice?>()
        val paused = IntroSession(IntroRequest.parse(raw("create" to null)).request!!) { answers.add(it) }
        assertFalse(paused.choose(IntroChoice.CREATE))
        assertFalse(paused.answered)
        assertTrue(paused.choose(IntroChoice.SIGN_IN))
        paused.close()
        assertFalse(paused.choose(IntroChoice.SIGN_IN))
        assertEquals(listOf<IntroChoice?>(IntroChoice.SIGN_IN), answers)

        val closed = mutableListOf<IntroChoice?>()
        val session = IntroSession(IntroRequest.parse(raw()).request!!) { closed.add(it) }
        session.close()
        assertFalse(session.choose(IntroChoice.CREATE))
        assertEquals(listOf<IntroChoice?>(null), closed)
    }

    @Test
    fun `back goes to the previous page, and from the first one out of the intro`() {
        assertEquals(1, introBackTarget(2))
        assertEquals(0, introBackTarget(1))
        assertNull(introBackTarget(0))
    }

    @Test
    fun `the wire names are the web's`() {
        assertEquals(listOf("story", "final"), IntroStart.entries.map { it.wire })
        assertEquals(listOf("create", "signIn"), IntroChoice.entries.map { it.wire })
    }
}
