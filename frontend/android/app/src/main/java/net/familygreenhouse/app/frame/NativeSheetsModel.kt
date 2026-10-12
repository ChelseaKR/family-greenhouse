package net.familygreenhouse.app.frame

// The parts of NativeChrome's `present`, `presentForm` and `setBarTools` that
// decide, in plain Kotlin with no Android types (NativeSheetsModelTest). Ports
// of ios/App/App/NativePresentModel.swift, NativeFormSheetModel.swift and the
// parsing half of NativeBarTools.swift, with the same rules:
//
// - An alert or action sheet reports a choice ONLY for a tap on a button that
//   is not the cancel button. Every other ending (back, a tap outside, the
//   web closing it, another one replacing it, the activity going away)
//   reports no choice, and nothing reports twice.
// - A form sheet reports values ONLY from its own submit button, with every
//   required field that shows filled in.
// - A bar menu pick is reported only for an id the web sent.
//
// Requests arrive as plain maps and lists (NativeChromePlugin converts the
// bridge's JSON), so these run on the JVM without Android's org.json.

enum class PresentKind(val raw: String) { ALERT("alert"), ACTION_SHEET("actionSheet") }

enum class PresentActionStyle(val raw: String) { DEFAULT("default"), DESTRUCTIVE("destructive"), CANCEL("cancel") }

data class PresentAction(val id: String, val title: String, val style: PresentActionStyle)

data class PresentRequest(
    val kind: PresentKind,
    val title: String?,
    val message: String?,
    val actions: List<PresentAction>,
) {
    val cancelAction: PresentAction get() = actions.first { it.style == PresentActionStyle.CANCEL }
    val choices: List<PresentAction> get() = actions.filter { it.style != PresentActionStyle.CANCEL }

    companion object {
        const val MAX_ACTIONS = 10

        /** The request, or why it was refused; a refused request is never shown. */
        fun parse(kind: String?, title: String?, message: String?, actions: List<Any?>?): Parsed<PresentRequest> {
            val k = PresentKind.entries.firstOrNull { it.raw == kind }
                ?: return Parsed.refused("kind must be alert or actionSheet")
            val t = title?.trim()?.takeIf { it.isNotEmpty() }
            val m = message?.trim()?.takeIf { it.isNotEmpty() }
            if (k == PresentKind.ALERT && t == null && m == null) {
                return Parsed.refused("an alert needs a title or a message")
            }
            if (actions == null || actions.isEmpty() || actions.size > MAX_ACTIONS) {
                return Parsed.refused("between 2 and $MAX_ACTIONS actions")
            }
            val parsed = mutableListOf<PresentAction>()
            val ids = mutableSetOf<String>()
            for (raw in actions) {
                val item = raw as? Map<*, *> ?: return Parsed.refused("every action needs an id, a title and a style")
                val id = item["id"] as? String
                val actionTitle = item["title"] as? String
                val style = PresentActionStyle.entries.firstOrNull { it.raw == item["style"] }
                if (id.isNullOrEmpty() || actionTitle.isNullOrBlank() || style == null) {
                    return Parsed.refused("every action needs an id, a title and a style")
                }
                if (!ids.add(id)) return Parsed.refused("action ids must be unique")
                parsed.add(PresentAction(id, actionTitle, style))
            }
            // Exactly one way out that confirms nothing.
            if (parsed.count { it.style == PresentActionStyle.CANCEL } != 1) {
                return Parsed.refused("exactly one cancel action")
            }
            if (parsed.none { it.style != PresentActionStyle.CANCEL }) {
                return Parsed.refused("at least one action besides cancel")
            }
            return Parsed.ok(PresentRequest(k, t, m, parsed))
        }
    }
}

/** A parse result: the value, or why it was refused. */
data class Parsed<T>(val value: T?, val error: String?) {
    companion object {
        fun <T> ok(value: T) = Parsed(value, null)
        fun <T> refused(error: String) = Parsed<T>(null, error)
    }
}

/** How one alert or sheet ended. Answers exactly once. */
class PresentOutcome(private val completion: (String?) -> Unit) {
    var answered = false
        private set

    /** A button was tapped. The cancel button reports no choice. */
    fun chose(action: PresentAction) = finish(if (action.style == PresentActionStyle.CANCEL) null else action.id)

    /** It ended any other way: dismissed, back, replaced, closed by the web. */
    fun cancel() = finish(null)

    private fun finish(id: String?) {
        if (answered) return
        answered = true
        completion(id)
    }
}

// ---- Form sheets -----------------------------------------------------------

data class FormSheetOption(val id: String, val title: String)

data class FormSheetCondition(val field: String, val equals: String)

sealed class FormSheetField {
    abstract val id: String
    abstract val label: String

    /** A pick-one list (a task's kind). */
    data class Choice(
        override val id: String,
        override val label: String,
        val options: List<FormSheetOption>,
        val value: String,
    ) : FormSheetField()

    /** A whole number with − and + (how many days between). */
    data class Stepper(
        override val id: String,
        override val label: String,
        val value: Int,
        val min: Int,
        val max: Int,
        val one: String,
        val other: String,
    ) : FormSheetField()

    /** Words. `required` only counts while the field shows. */
    data class Text(
        override val id: String,
        override val label: String,
        val value: String,
        val placeholder: String?,
        val multiline: Boolean,
        val required: Boolean,
        val maxLength: Int,
        val visibleWhen: FormSheetCondition?,
    ) : FormSheetField()
}

/** A field's value: words or a whole number. */
sealed class FormSheetValue {
    data class Words(val text: String) : FormSheetValue()
    data class Number(val number: Int) : FormSheetValue()

    val asAny: Any
        get() = when (this) {
            is Words -> text
            is Number -> number
        }
}

data class FormSheetRequest(
    val title: String,
    val message: String?,
    val cancel: String,
    val submit: String,
    val fields: List<FormSheetField>,
) {
    val initialValues: Map<String, FormSheetValue>
        get() = fields.associate { field ->
            field.id to when (field) {
                is FormSheetField.Choice -> FormSheetValue.Words(field.value)
                is FormSheetField.Stepper -> FormSheetValue.Number(field.value)
                is FormSheetField.Text -> FormSheetValue.Words(field.value)
            }
        }

    fun isVisible(field: FormSheetField, values: Map<String, FormSheetValue>): Boolean {
        val condition = (field as? FormSheetField.Text)?.visibleWhen ?: return true
        return values[condition.field] == FormSheetValue.Words(condition.equals)
    }

    /** The submit button works only when every required field that shows has words. */
    fun canSubmit(values: Map<String, FormSheetValue>): Boolean {
        for (field in fields) {
            if (field !is FormSheetField.Text || !field.required || !isVisible(field, values)) continue
            val text = (values[field.id] as? FormSheetValue.Words)?.text ?: return false
            if (text.isBlank()) return false
        }
        return true
    }

    /** The shown fields' values; a hidden field is not sent. */
    fun submitted(values: Map<String, FormSheetValue>): Map<String, Any> {
        val out = linkedMapOf<String, Any>()
        for (field in fields) {
            if (!isVisible(field, values)) continue
            values[field.id]?.let { out[field.id] = it.asAny }
        }
        return out
    }

    companion object {
        const val MAX_FIELDS = 12

        fun stepperWords(one: String, other: String, value: Int): String =
            if (value == 1) one else other.replace("{n}", value.toString())

        fun parse(raw: Map<String, Any?>): Parsed<FormSheetRequest> {
            fun words(key: String): String? = (raw[key] as? String)?.trim()?.takeIf { it.isNotEmpty() }
            val title = words("title")
            val cancel = words("cancel")
            val submit = words("submit")
            if (title == null || cancel == null || submit == null) {
                return Parsed.refused("a form sheet needs a title, cancel and submit")
            }
            val rawFields = raw["fields"] as? List<*>
            if (rawFields == null || rawFields.isEmpty() || rawFields.size > MAX_FIELDS) {
                return Parsed.refused("between 1 and $MAX_FIELDS fields")
            }
            val fields = mutableListOf<FormSheetField>()
            val ids = mutableSetOf<String>()
            for (entry in rawFields) {
                val item = entry as? Map<*, *> ?: return Parsed.refused("every field needs a unique id, a label and a kind")
                val id = item["id"] as? String
                val label = item["label"] as? String
                val kind = item["kind"] as? String
                if (id.isNullOrEmpty() || !ids.add(id) || label.isNullOrEmpty() || kind == null) {
                    return Parsed.refused("every field needs a unique id, a label and a kind")
                }
                when (kind) {
                    "choice" -> {
                        val options = (item["options"] as? List<*> ?: emptyList<Any>()).mapNotNull { o ->
                            val option = o as? Map<*, *> ?: return@mapNotNull null
                            val oid = option["id"] as? String
                            val otitle = option["title"] as? String
                            if (oid.isNullOrEmpty() || otitle.isNullOrEmpty()) null else FormSheetOption(oid, otitle)
                        }
                        val value = item["value"] as? String
                        if (options.isEmpty() || value == null || options.none { it.id == value }) {
                            return Parsed.refused("a choice needs options and one of them as its value")
                        }
                        fields.add(FormSheetField.Choice(id, label, options, value))
                    }
                    "stepper" -> {
                        val min = (item["min"] as? Number)?.toInt()
                        val max = (item["max"] as? Number)?.toInt()
                        val value = (item["value"] as? Number)?.toInt()
                        val one = item["one"] as? String
                        val other = item["other"] as? String
                        if (min == null || max == null || min > max || value == null || one == null || other == null) {
                            return Parsed.refused("a stepper needs min <= max, a value and its words")
                        }
                        fields.add(FormSheetField.Stepper(id, label, value.coerceIn(min, max), min, max, one, other))
                    }
                    "text" -> {
                        var condition: FormSheetCondition? = null
                        val whenRaw = item["visibleWhen"]
                        if (whenRaw != null) {
                            val w = whenRaw as? Map<*, *>
                            val field = w?.get("field") as? String
                            val equals = w?.get("equals") as? String
                            if (field == null || equals == null) return Parsed.refused("visibleWhen needs a field and a value")
                            condition = FormSheetCondition(field, equals)
                        }
                        fields.add(
                            FormSheetField.Text(
                                id = id,
                                label = label,
                                value = item["value"] as? String ?: "",
                                placeholder = item["placeholder"] as? String,
                                multiline = item["multiline"] as? Boolean ?: false,
                                required = item["required"] as? Boolean ?: false,
                                maxLength = (item["maxLength"] as? Number)?.toInt() ?: 500,
                                visibleWhen = condition,
                            )
                        )
                    }
                    else -> return Parsed.refused("kind must be choice, stepper or text")
                }
            }
            for (field in fields) {
                val condition = (field as? FormSheetField.Text)?.visibleWhen ?: continue
                if (condition.field !in ids) return Parsed.refused("visibleWhen names no field")
            }
            return Parsed.ok(FormSheetRequest(title, words("message"), cancel, submit, fields))
        }
    }
}

/** How one form sheet ended: the values on a submit, null any other way. */
class FormSheetOutcome(private val completion: (Map<String, Any>?) -> Unit) {
    var answered = false
        private set

    /** The submit button. A submit while a required field is empty reports
     *  nothing (the button is disabled then; this is the second lock). */
    fun submit(request: FormSheetRequest, values: Map<String, FormSheetValue>) {
        if (!request.canSubmit(values)) return
        finish(request.submitted(values))
    }

    fun cancel() = finish(null)

    private fun finish(values: Map<String, Any>?) {
        if (answered) return
        answered = true
        completion(values)
    }
}

// ---- Bar tools -------------------------------------------------------------

data class BarMenuItem(val id: String, val title: String, val checked: Boolean?)

data class BarMenuGroup(val title: String?, val items: List<BarMenuItem>)

data class BarMenu(val id: String, val label: String, val symbol: String, val groups: List<BarMenuGroup>)

data class BarSearch(val placeholder: String, val text: String)

data class BarTools(val path: String, val menus: List<BarMenu>, val search: BarSearch?) {
    val isEmpty: Boolean get() = menus.isEmpty() && search == null

    /** Whether `id` is an item these tools offered: only those reach the web. */
    fun offers(id: String): Boolean = item(id) != null

    /** A pick-one option (a filter or grouping) reshapes the list. */
    fun reshapesList(id: String): Boolean = item(id)?.checked != null

    private fun item(id: String): BarMenuItem? =
        menus.asSequence().flatMap { it.groups }.flatMap { it.items }.firstOrNull { it.id == id }

    companion object {
        /** Malformed parts are dropped rather than drawn half-right; no path, no tools. */
        fun parse(path: String?, menus: List<Any?>?, search: Map<*, *>?): BarTools? {
            if (path.isNullOrEmpty()) return null
            val parsedMenus = (menus ?: emptyList()).mapNotNull { m ->
                val raw = m as? Map<*, *> ?: return@mapNotNull null
                val id = raw["id"] as? String
                val label = raw["label"] as? String
                val symbol = raw["symbol"] as? String
                if (id.isNullOrEmpty() || label == null || symbol == null) return@mapNotNull null
                val groups = (raw["groups"] as? List<*> ?: emptyList<Any>()).mapNotNull { g ->
                    val group = g as? Map<*, *> ?: return@mapNotNull null
                    val items = (group["items"] as? List<*> ?: emptyList<Any>()).mapNotNull { i ->
                        val item = i as? Map<*, *> ?: return@mapNotNull null
                        val iid = item["id"] as? String
                        val title = item["label"] as? String
                        if (iid.isNullOrEmpty() || title.isNullOrEmpty()) null
                        else BarMenuItem(iid, title, item["checked"] as? Boolean)
                    }
                    if (items.isEmpty()) null else BarMenuGroup(group["title"] as? String, items)
                }
                if (groups.isEmpty()) null else BarMenu(id, label, symbol, groups)
            }
            val parsedSearch = search?.let {
                BarSearch(it["placeholder"] as? String ?: "", it["text"] as? String ?: "")
            }
            return BarTools(path, parsedMenus, parsedSearch)
        }
    }
}

/** Tools by route; an identical send changes nothing, an empty one removes them. */
class BarToolsStore {
    private val byPath = mutableMapOf<String, BarTools>()

    fun set(tools: BarTools): Boolean {
        if (tools.isEmpty) return byPath.remove(tools.path) != null
        if (byPath[tools.path] == tools) return false
        byPath[tools.path] = tools
        return true
    }

    fun tools(path: String): BarTools? = byPath[path]

    fun removeAll() = byPath.clear()
}

/** What the search field reports: a change of text, once per value. Text the
 *  web put back is not echoed to it. */
class SearchEcho {
    var lastReported: String = ""
        private set

    fun userTyped(text: String): String? {
        if (text == lastReported) return null
        lastReported = text
        return text
    }

    fun webSet(text: String) {
        lastReported = text
    }
}
