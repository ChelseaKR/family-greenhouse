package net.familygreenhouse.app.frame

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Material 3 for the app's native surfaces, from the brand palette
 * (docs/brand.md; the `@theme` block of frontend/src/index.css), not from the
 * wallpaper. Dynamic color would repaint the bars in whatever the wallpaper
 * is, around a page that is always the brand's greens and paper.
 *
 * Light only, like the rest of the app: the web has no dark theme, and the
 * iOS app pins `UIUserInterfaceStyle` to Light for the same reason. Dark
 * bars around a light page read as a broken frame, so a phone in dark mode
 * gets the same light frame (docs/mobile.md, "Status bar").
 */
object FgColors {
    val forest = Color(0xFF173404)
    val canopy = Color(0xFF27500A)
    val leafDark = Color(0xFF3B6D11)
    val leafMid = Color(0xFF639922)
    val leafPale = Color(0xFFC0DD97)
    val leafWash = Color(0xFFEAF3DE)
    val glass = Color(0xFFDDEEE7)
    val dew = Color(0xFFB7D9D1)
    val paper = Color(0xFFF7F8F2)
    val parchment = Color(0xFFEEF1E6)
    val terracotta = Color(0xFFA23F1A)
    val terracottaWash = Color(0xFFFAE6D4)
    val ink = Color(0xFF1A2412)
    val inkSoft = Color(0xFF44503A)
    val danger = Color(0xFFB3261E)
}

val FgColorScheme = lightColorScheme(
    primary = FgColors.leafDark,
    onPrimary = Color.White,
    primaryContainer = FgColors.leafPale,
    onPrimaryContainer = FgColors.forest,
    inversePrimary = FgColors.leafPale,
    secondary = FgColors.canopy,
    onSecondary = Color.White,
    // The selected tab's pill and a selected chip.
    secondaryContainer = FgColors.leafPale,
    onSecondaryContainer = FgColors.forest,
    tertiary = FgColors.terracotta,
    onTertiary = Color.White,
    tertiaryContainer = FgColors.terracottaWash,
    onTertiaryContainer = Color(0xFF5E2614),
    background = FgColors.paper,
    onBackground = FgColors.ink,
    surface = FgColors.paper,
    onSurface = FgColors.ink,
    surfaceVariant = FgColors.glass,
    onSurfaceVariant = FgColors.inkSoft,
    surfaceTint = FgColors.leafDark,
    surfaceBright = FgColors.paper,
    surfaceDim = Color(0xFFDCE0D2),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF2F4EC),
    surfaceContainer = FgColors.parchment,
    surfaceContainerHigh = Color(0xFFE8ECDF),
    surfaceContainerHighest = Color(0xFFE2E7D8),
    outline = Color(0xFF74806A),
    outlineVariant = FgColors.dew,
    error = FgColors.danger,
    onError = Color.White,
    errorContainer = Color(0xFFF9DEDC),
    onErrorContainer = Color(0xFF410E0B),
)

@Composable
fun FgTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = FgColorScheme, content = content)
}
