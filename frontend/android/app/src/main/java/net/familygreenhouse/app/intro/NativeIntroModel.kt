package net.familygreenhouse.app.intro

// The signed-out intro (NativeIntro `present`): what the web asked for, and
// what the intro may answer. A port of ios/App/App/NativeIntroModel.swift,
// in plain Kotlin with no Android types, so it runs as a JVM unit test
// (NativeIntroModelTest.kt). NativeIntroView.kt draws it; NativeIntroPlugin.kt
// carries it over the bridge.
//
// The web owns every word, in the app's language (frontend/src/config/
// nativeIntro.ts, from the en and es catalogs); Kotlin owns the pictures, the
// paging and the motion. The intro never signs anyone in or up: it reports
// which of the two doors the person chose and the web opens that screen.

/**
 * One page of the intro. [id] picks the illustration (`household`, `claim`,
 * `away`, `start`); an id this build does not know gets none, so a page the
 * web adds later still shows its words.
 */
data class IntroPage(val id: String, val title: String, val body: String)

/**
 * Where the intro opens: the whole story (the first signed-out launch on this
 * install), or only the last page (after that, and after sign-out).
 */
enum class IntroStart(val wire: String) {
    STORY("story"),
    FINAL("final");

    companion object {
        fun of(wire: String?): IntroStart? = entries.firstOrNull { it.wire == wire }
    }
}

/** The two doors on the last page. Anything else is no choice. */
enum class IntroChoice(val wire: String) {
    CREATE("create"),
    SIGN_IN("signIn"),
}

data class IntroRequest(
    val start: IntroStart,
    /** The story pages, then the last page; never empty. */
    val pages: List<IntroPage>,
    val skip: String,
    val next: String,
    /** "Page {n} of {total}", for TalkBack on the page indicator. */
    val pagePosition: String,
    /** The wordmark and tagline above the last page's title. */
    val appName: String,
    val tagline: String,
    /** "Create account"; null when registration is paused, and then the last
     *  page offers only the sign-in door. */
    val create: String?,
    /** "I already have an account". */
    val signIn: String,
) {
    /** The pages this presentation shows: all of them for the story, only
     *  the last for `final`. */
    val shownPages: List<IntroPage>
        get() = if (start == IntroStart.FINAL) listOf(pages.last()) else pages

    /** Story pages get Skip, Next and the page indicator; the last page has
     *  the two doors instead. */
    fun isLast(index: Int): Boolean = index >= shownPages.size - 1

    fun position(index: Int): String = pagePosition
        .replace("{n}", (index + 1).toString())
        .replace("{total}", shownPages.size.toString())

    companion object {
        /**
         * Reads the bridge's options. Every word must be there: an intro with
         * a blank button is refused, and the web keeps its own sign-in screen.
         * The same rules and messages as IntroRequest.parse in Swift.
         */
        fun parse(raw: Map<String, Any?>): Parsed {
            val start = IntroStart.of(raw["start"] as? String)
                ?: return Parsed(null, "start must be story or final")
            val pages = (raw["pages"] as? List<*> ?: emptyList<Any?>()).mapNotNull { entry ->
                val page = entry as? Map<*, *> ?: return@mapNotNull null
                val id = page["id"] as? String
                val title = page["title"] as? String
                if (id.isNullOrEmpty() || title.isNullOrEmpty()) return@mapNotNull null
                IntroPage(id, title, page["body"] as? String ?: "")
            }
            if (pages.isEmpty()) return Parsed(null, "an intro needs at least one page")
            fun word(key: String): String? = (raw[key] as? String)?.takeIf { it.isNotEmpty() }
            val signIn = word("signIn") ?: return Parsed(null, "signIn is required")
            val skip = word("skip")
            val next = word("next")
            val pagePosition = word("pagePosition")
            if (skip == null || next == null || pagePosition == null) {
                return Parsed(null, "skip, next and pagePosition are required")
            }
            return Parsed(
                IntroRequest(
                    start = start,
                    pages = pages,
                    skip = skip,
                    next = next,
                    pagePosition = pagePosition,
                    appName = word("appName") ?: "",
                    tagline = word("tagline") ?: "",
                    create = word("create"),
                    signIn = signIn,
                ),
                null,
            )
        }
    }

    data class Parsed(val request: IntroRequest?, val error: String?)
}

/**
 * How one intro ended. Answers exactly once: the door that was tapped, or
 * null any other way (the web closed it, another one replaced it, back on its
 * first page). Create is a choice only when it was offered.
 */
class IntroSession(val request: IntroRequest, private val answer: (IntroChoice?) -> Unit) {
    var answered = false
        private set

    /** A door was tapped. False when it is not one this intro offers or the
     *  intro has already answered. */
    fun choose(choice: IntroChoice): Boolean {
        if (choice == IntroChoice.CREATE && request.create == null) return false
        return finish(choice)
    }

    /** Closed without a choice. */
    fun close() {
        finish(null)
    }

    private fun finish(choice: IntroChoice?): Boolean {
        if (answered) return false
        answered = true
        answer(choice)
        return true
    }
}

/**
 * Where Android back goes inside the intro: to the previous page, as in any
 * Material onboarding pager; from the first page shown (the only page, after
 * a sign-out), out of the intro with no choice, onto the web's sign-in
 * screen underneath. Never out of the app while the intro is up.
 */
fun introBackTarget(index: Int): Int? = if (index > 0) index - 1 else null
