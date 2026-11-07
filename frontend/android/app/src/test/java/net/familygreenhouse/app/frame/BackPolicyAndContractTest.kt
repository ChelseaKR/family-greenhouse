package net.familygreenhouse.app.frame

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Back on the screens with no bars, and the contract with the web: the
 * sign-in list, the icons the web names, and the plugin's method list.
 * Paths are relative to the app module, where Gradle runs unit tests.
 */
class BackPolicyAndContractTest {
    private val origin = "https://localhost"

    @Test
    fun `back on sign-in goes between sign-in screens, never across into the app or onto slash`() {
        assertTrue(BackPolicy.allows("$origin/register", "$origin/login"))
        assertFalse(BackPolicy.allows("$origin/dashboard", "$origin/login"))
        assertFalse(BackPolicy.allows("$origin/login", "$origin/dashboard"))
        assertFalse(BackPolicy.allows("$origin/login", "$origin/"))
        assertFalse(BackPolicy.allows("$origin/login", null))
        assertFalse(BackPolicy.allows("$origin/register", "https://example.com/login"))
        assertTrue(BackPolicy.allows("$origin/forgot-password?x=1", "$origin/login/"))
    }

    private fun web(path: String) = File("../../src/$path").readText()

    @Test
    fun `the sign-in list is the web's SIGN_IN_AND_SETUP_PATHS`() {
        val block = Regex("SIGN_IN_AND_SETUP_PATHS[^=]*=\\s*\\[([^\\]]*)]").find(web("config/nativeFrame.ts"))!!
        val paths = Regex("'([^']+)'").findAll(block.groupValues[1]).map { it.groupValues[1] }.toSet()
        assertEquals(paths, BackPolicy.signInAndSetupPaths)
    }

    @Test
    fun `every SF Symbol the web sends has a Material Symbol here`() {
        val sources = listOf(
            "config/nativeFrame.ts",
            "features/plants/PlantsPage.tsx",
            "features/plants/PlantDetailPage.tsx",
            "features/tasks/TasksPage.tsx",
        ).joinToString("\n") { web(it) }
        val named = Regex("(?:selectedSymbol|symbol):\\s*'([a-z0-9.]+)'").findAll(sources).map { it.groupValues[1] }.toSet()
        assertTrue("found no symbols; did the sources move?", named.size > 20)
        assertEquals(emptySet<String>(), named - NativeFrameIcons.known)
    }

    @Test
    fun `the plugin answers every method the web's NativeChrome interface declares`() {
        val declared = Regex("^\\s{2}(\\w+)\\(", RegexOption.MULTILINE)
            .findAll(web("services/nativeChrome.ts").substringAfter("export interface NativeChromePlugin").substringBefore("\n}"))
            .map { it.groupValues[1] }
            .filter { it != "addListener" }
            .toSet()
        val plugin = File("src/main/java/net/familygreenhouse/app/frame/NativeChromePlugin.kt").readText()
        val implemented = Regex("@PluginMethod\\s+fun (\\w+)").findAll(plugin).map { it.groupValues[1] }.toSet()
        assertEquals(declared, implemented)
    }
}
