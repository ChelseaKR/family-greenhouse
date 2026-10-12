package net.familygreenhouse.app.frame

/**
 * Whether Android back may take the app from `current` back to `back` in the
 * web view's own history, on the screens with no bars (sign-in, setup). The
 * same rule as BackSwipePolicy in ios/App/App/MainViewController.swift:
 *
 * - Nothing behind (the first screen): no, back leaves the app.
 * - Another origin than the app's own: no.
 * - `/`, which only ever redirects: no.
 * - Across the line between sign-in or setup and the signed-in app: no, so
 *   back after signing in never lands on a sign-in screen that redirects, and
 *   back after signing out never lands on an app screen that bounces.
 *
 * Paths are routes in frontend/src/App.tsx (SIGN_IN_AND_SETUP_PATHS in
 * frontend/src/config/nativeFrame.ts; nativeFrame.test.ts holds the three
 * lists together). URLs are split by hand so this runs on the JVM.
 */
object BackPolicy {
    val signInAndSetupPaths: Set<String> = setOf(
        "/login",
        "/register",
        "/confirm-email",
        "/forgot-password",
        "/reset-password",
        "/onboarding",
        "/welcome",
    )

    fun allows(current: String?, back: String?): Boolean {
        if (current == null || back == null) return false
        val (currentOrigin, currentPath) = split(current) ?: return false
        val (backOrigin, backPath) = split(back) ?: return false
        if (currentOrigin != backOrigin) return false
        if (backPath == "/") return false
        return (backPath in signInAndSetupPaths) == (currentPath in signInAndSetupPaths)
    }

    /** scheme://host[:port] and the normalized path, or null for a URL without a scheme. */
    private fun split(url: String): Pair<String, String>? {
        val schemeEnd = url.indexOf("://")
        if (schemeEnd <= 0) return null
        val rest = url.substring(schemeEnd + 3)
        val pathStart = rest.indexOfAny(charArrayOf('/', '?', '#')).let { if (it < 0) rest.length else it }
        val origin = url.substring(0, schemeEnd + 3) + rest.substring(0, pathStart)
        var path = rest.substring(pathStart).substringBefore('#').substringBefore('?')
        if (path.isEmpty()) path = "/"
        if (path.length > 1 && path.endsWith("/")) path = path.dropLast(1)
        return origin to path
    }
}
