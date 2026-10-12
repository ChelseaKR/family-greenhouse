package net.familygreenhouse.app.frame

/** One row of the More list or of Settings' list. */
data class MoreItem(
    val id: String,
    val title: String,
    val symbol: String? = null,
    val path: String? = null,
    val checked: Boolean = false,
    val destructive: Boolean = false,
)

data class MoreSection(val title: String?, val items: List<MoreItem>)

/** A tab as the web configures it: words and SF Symbol names. */
data class FrameTabStyle(val id: String, val title: String, val symbol: String, val selectedSymbol: String)

/** What `configure` carries (frontend/src/config/nativeFrame.ts, NativeChromeConfiguration). */
data class FrameConfiguration(
    val tabs: List<FrameTab>,
    val styles: List<FrameTabStyle>,
    val moreTitle: String,
    val moreSections: List<MoreSection>,
    val signOutTitle: String,
    val signOutConfirm: String,
    val signOutCancel: String,
    val settingsTitle: String,
    val settingsSections: List<MoreSection>,
) {
    companion object {
        /** More's Settings row opens this native list (NativeFrameController.settingsListPath on iOS). */
        const val SETTINGS_LIST_PATH = "native:settings"

        fun parse(raw: Map<String, Any?>): FrameConfiguration {
            val rawTabs = (raw["tabs"] as? List<*>).orEmpty().mapNotNull { it as? Map<*, *> }
            val tabs = rawTabs.mapNotNull { t ->
                val id = t["id"] as? String ?: return@mapNotNull null
                val title = t["title"] as? String ?: return@mapNotNull null
                FrameTab(id, title, t["root"] as? String)
            }
            val styles = rawTabs.mapNotNull { t ->
                val id = t["id"] as? String ?: return@mapNotNull null
                FrameTabStyle(
                    id = id,
                    title = t["title"] as? String ?: "",
                    symbol = t["symbol"] as? String ?: "circle",
                    selectedSymbol = t["selectedSymbol"] as? String ?: "circle",
                )
            }
            val settings = raw["settings"] as? Map<*, *> ?: emptyMap<String, Any?>()
            val confirm = raw["signOutConfirm"] as? Map<*, *> ?: emptyMap<String, Any?>()
            return FrameConfiguration(
                tabs = tabs,
                styles = styles,
                moreTitle = raw["moreTitle"] as? String ?: "",
                moreSections = sections(raw["moreSections"] as? List<*>),
                signOutTitle = confirm["title"] as? String ?: "",
                signOutConfirm = confirm["confirm"] as? String ?: "",
                signOutCancel = confirm["cancel"] as? String ?: "",
                settingsTitle = settings["title"] as? String ?: "",
                settingsSections = sections(settings["sections"] as? List<*>),
            )
        }

        /** More's sections and Settings' sections have the same shape. */
        fun sections(raw: List<*>?): List<MoreSection> =
            raw.orEmpty().mapNotNull { it as? Map<*, *> }.map { section ->
                MoreSection(
                    title = section["title"] as? String,
                    items = (section["items"] as? List<*>).orEmpty().mapNotNull { it as? Map<*, *> }.mapNotNull { item ->
                        val id = item["id"] as? String ?: return@mapNotNull null
                        val title = item["title"] as? String ?: return@mapNotNull null
                        MoreItem(
                            id = id,
                            title = title,
                            symbol = item["symbol"] as? String,
                            path = item["path"] as? String,
                            checked = item["checked"] as? Boolean ?: false,
                            destructive = item["destructive"] as? Boolean ?: false,
                        )
                    },
                )
            }
    }
}

/** Parses an `update` the way NativeChromePlugin.swift does. Null without a path and a key. */
fun parseReport(raw: Map<String, Any?>): FrameReport? {
    val path = raw["path"] as? String ?: return null
    val key = raw["key"] as? String ?: return null
    val button = (raw["rightButton"] as? Map<*, *>)?.let { b ->
        val id = b["id"] as? String
        val symbol = b["symbol"] as? String
        if (id == null || symbol == null) null else FrameBarButton(id, symbol, b["label"] as? String ?: "")
    }
    return FrameReport(
        path = path,
        key = key,
        title = raw["title"] as? String ?: "",
        tab = raw["tab"] as? String,
        canGoBack = raw["canGoBack"] as? Boolean ?: false,
        largeTitle = raw["largeTitle"] as? Boolean ?: false,
        chrome = FrameChrome.from(raw["chrome"] as? String),
        navigation = FrameNavigation.from(raw["navigation"] as? String),
        rightButton = button,
    )
}
