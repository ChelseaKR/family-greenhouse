package net.familygreenhouse.app.frame

import net.familygreenhouse.app.R

/**
 * The web names its icons as SF Symbols (frontend/src/config/nativeFrame.ts,
 * the bar tools in PlantsPage, TasksPage and PlantDetailPage), because the
 * iOS frame draws them as such. Android draws the Material Symbol for the same
 * idea (res/drawable/ic_fg_*.xml). A name with no mapping draws a plain
 * circle, never nothing, and NativeFrameIconsTest fails on any SF Symbol the
 * web sends that is missing here.
 */
object NativeFrameIcons {
    private val outlined: Map<String, Int> = mapOf(
        "house" to R.drawable.ic_fg_home,
        "leaf" to R.drawable.ic_fg_eco,
        "checkmark.circle" to R.drawable.ic_fg_check_circle,
        "person.2" to R.drawable.ic_fg_group,
        "ellipsis.circle" to R.drawable.ic_fg_more_horiz,
        "sun.max" to R.drawable.ic_fg_light_mode,
        "bubble.left.and.bubble.right" to R.drawable.ic_fg_forum,
        "chart.bar" to R.drawable.ic_fg_bar_chart,
        "gearshape" to R.drawable.ic_fg_settings,
        "questionmark.circle" to R.drawable.ic_fg_help,
        "info.circle" to R.drawable.ic_fg_info,
        "plus" to R.drawable.ic_fg_add,
        "slider.horizontal.3" to R.drawable.ic_fg_tune,
        "bell" to R.drawable.ic_fg_notifications,
        "person.badge.plus" to R.drawable.ic_fg_person_add,
        "tag" to R.drawable.ic_fg_sell,
        "display" to R.drawable.ic_fg_tv,
        "key" to R.drawable.ic_fg_key,
        "trash" to R.drawable.ic_fg_delete,
        "lock" to R.drawable.ic_fg_lock,
        "person.crop.circle" to R.drawable.ic_fg_account_circle,
        "line.3.horizontal.decrease.circle" to R.drawable.ic_fg_filter_list,
    )

    private val filled: Map<String, Int> = mapOf(
        "house.fill" to R.drawable.ic_fg_home_fill,
        "leaf.fill" to R.drawable.ic_fg_eco_fill,
        "checkmark.circle.fill" to R.drawable.ic_fg_check_circle_fill,
        "person.2.fill" to R.drawable.ic_fg_group_fill,
        "ellipsis.circle.fill" to R.drawable.ic_fg_more_horiz_fill,
    )

    /** Every SF Symbol name this file draws, for the test. */
    val known: Set<String> get() = outlined.keys + filled.keys

    fun forSymbol(name: String?): Int = name?.let { filled[it] ?: outlined[it] } ?: R.drawable.ic_fg_circle

    /**
     * A menu button in the top app bar. "More" is the vertical three dots on
     * Android (the overflow menu), where iOS draws a circled ellipsis.
     */
    fun forBarMenu(name: String): Int =
        if (name == "ellipsis.circle") R.drawable.ic_fg_more_vert else forSymbol(name)
}
