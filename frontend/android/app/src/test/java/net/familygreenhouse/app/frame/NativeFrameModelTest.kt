package net.familygreenhouse.app.frame

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The frame's back stacks, as NativeFrameModel.swift keeps them on iOS. */
class NativeFrameModelTest {
    private lateinit var history: TabHistory

    private val tabs = listOf(
        FrameTab("home", "Home", "/dashboard"),
        FrameTab("plants", "Plants", "/plants"),
        FrameTab("tasks", "Tasks", "/tasks"),
        FrameTab("household", "Household", "/household"),
        FrameTab("more", "More", null),
    )

    private fun report(
        path: String,
        key: String,
        tab: String?,
        chrome: FrameChrome = FrameChrome.TABS,
        navigation: FrameNavigation = FrameNavigation.PUSH,
        title: String = "",
    ) = FrameReport(
        path = path,
        key = key,
        title = title,
        tab = tab,
        canGoBack = tabs.none { it.root == path },
        largeTitle = tabs.any { it.root == path },
        chrome = chrome,
        navigation = navigation,
    )

    @Before
    fun setUp() {
        history = TabHistory()
        history.configure(tabs, "More")
    }

    @Test
    fun `sign-in shows no bars and signing in shows the first tab`() {
        assertEquals(FrameChange.None, history.apply(report("/login", "a", null, FrameChrome.NONE)))
        assertFalse(history.chromeShown)
        assertEquals(FrameChange.ShowTab("home"), history.apply(report("/dashboard", "b", "home")))
        assertEquals(listOf("/dashboard"), history.stack("home").map { it.path })
    }

    @Test
    fun `a deep link into another tab keeps the tab's root beneath it`() {
        history.apply(report("/dashboard", "a", "home"))
        assertEquals(FrameChange.ShowTab("plants"), history.apply(report("/plants/p1", "b", "plants")))
        assertEquals(listOf("/plants", "/plants/p1"), history.stack("plants").map { it.path })
    }

    @Test
    fun `push, then back pops to the screen below and names it for the web`() {
        history.apply(report("/plants", "a", "plants"))
        assertEquals(FrameChange.Push, history.apply(report("/plants/p1", "b", "plants")))
        assertEquals(BackTarget.PopTo(1), history.backTarget())
        assertEquals("/plants", history.didPop(1))
        assertEquals(listOf("/plants"), history.stack("plants").map { it.path })
    }

    @Test
    fun `back from another tab's first screen goes to Home, and from Home it leaves`() {
        history.apply(report("/dashboard", "a", "home"))
        history.apply(report("/tasks", "b", "tasks"))
        assertEquals(BackTarget.FirstTab("home"), history.backTarget())
        history.select("home")
        assertEquals(BackTarget.Leave, history.backTarget())
    }

    @Test
    fun `a tab keeps its stack while another tab shows`() {
        history.apply(report("/plants", "a", "plants"))
        history.apply(report("/plants/p1", "b", "plants"))
        val toTasks = history.select("tasks")
        assertEquals(FrameChange.ShowTab("tasks"), toTasks.change)
        assertEquals("/tasks", toTasks.path)
        val back = history.select("plants")
        assertEquals("/plants/p1", back.path)
        assertFalse(back.reselect)
    }

    @Test
    fun `the current tab again pops to its root, and at the root asks for the top`() {
        history.apply(report("/plants", "a", "plants"))
        history.apply(report("/plants/p1", "b", "plants"))
        val again = history.select("plants")
        assertEquals(FrameChange.Pop(1), again.change)
        assertEquals("/plants", again.path)
        assertTrue(again.reselect)
        assertEquals(TabSelection(FrameChange.None, null, true), history.select("plants"))
    }

    @Test
    fun `More is a native list, and Settings is pushed on it without telling the web`() {
        history.apply(report("/dashboard", "a", "home"))
        val more = history.select("more")
        assertNull(more.path)
        assertTrue(history.top!!.isNativeList)
        assertEquals(FrameChange.Push, history.pushNativeList("native:settings", "Settings"))
        assertEquals(FrameChange.None, history.pushNativeList("native:settings", "Settings"))
        // A section page from the Settings list, then back to the list.
        assertEquals(FrameChange.Push, history.apply(report("/settings?section=notifications", "c", "more")))
        assertNull(history.didPop(2))
        assertEquals("native:settings", history.top!!.path)
    }

    @Test
    fun `a replaced screen takes the top's place, but never the root's`() {
        history.apply(report("/plants", "a", "plants"))
        assertEquals(
            FrameChange.Push,
            history.apply(report("/plants?filter=mine", "b", "plants", navigation = FrameNavigation.REPLACE)),
        )
        assertEquals(
            FrameChange.ReplaceTop,
            history.apply(report("/plants?filter=all", "c", "plants", navigation = FrameNavigation.REPLACE)),
        )
        assertEquals(2, history.stack("plants").size)
    }

    @Test
    fun `the same screen again only refreshes its title`() {
        history.apply(report("/plants", "a", "plants"))
        history.apply(report("/plants/p1", "b", "plants"))
        assertEquals(FrameChange.RefreshTop, history.apply(report("/plants/p1", "b", "plants", title = "Monstera")))
        assertEquals("Monstera", history.top!!.title)
        assertEquals(FrameChange.None, history.apply(report("/plants/p1", "b", "plants", title = "Monstera")))
    }

    @Test
    fun `signing out hides the bars and forgets every stack`() {
        history.apply(report("/plants", "a", "plants"))
        history.apply(report("/plants/p1", "b", "plants"))
        assertEquals(FrameChange.HideChrome, history.apply(report("/login", "c", null, FrameChrome.NONE)))
        assertTrue(history.stack("plants").isEmpty())
        assertEquals(BackTarget.Leave, history.backTarget())
    }

    @Test
    fun `a language change retitles the roots and keeps the stacks`() {
        history.apply(report("/plants", "a", "plants"))
        history.apply(report("/plants/p1", "b", "plants"))
        history.configure(tabs.map { if (it.id == "plants") it.copy(title = "Plantas") else it }, "Más")
        assertEquals("Plantas", history.stack("plants")[0].title)
        assertEquals(2, history.stack("plants").size)
    }
}
