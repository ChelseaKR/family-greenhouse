package net.familygreenhouse.app.frame

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject

/**
 * The web half of the native frame talks to the Kotlin half through this
 * plugin: the same name, methods, payloads and events as
 * ios/App/App/NativeChromePlugin.swift, written down once in
 * frontend/src/config/nativeFrame.ts (and nativePresent.ts,
 * nativeFormSheet.ts, nativeBarTools.ts). The web uses each method only when
 * the bridge's `Capacitor.PluginHeaders` lists it (lib/platform.ts), so a
 * method missing here keeps the web's own version of that surface.
 *
 * Capacitor runs plugin methods off the main thread; every one hands its
 * work to the main thread before touching the frame.
 */
@CapacitorPlugin(name = "NativeChrome")
class NativeChromePlugin : Plugin(), FrameEvents {
    /** Set by MainActivity once the frame is installed. */
    var frame: NativeFrameController? = null

    @PluginMethod
    fun configure(call: PluginCall) {
        val configuration = FrameConfiguration.parse(toMap(call.data))
        onMain(call) { it.configure(configuration); call.resolve() }
    }

    @PluginMethod
    fun update(call: PluginCall) {
        val report = parseReport(toMap(call.data))
        if (report == null) {
            call.reject("update needs a path and a key", "INVALID")
            return
        }
        onMain(call) { it.apply(report); call.resolve() }
    }

    @PluginMethod
    fun present(call: PluginCall) {
        val token = call.getString("token")
        if (token.isNullOrEmpty()) {
            call.reject("present needs a token", "INVALID")
            return
        }
        val data = toMap(call.data)
        val parsed = PresentRequest.parse(
            kind = data["kind"] as? String,
            title = data["title"] as? String,
            message = data["message"] as? String,
            actions = data["actions"] as? List<*>,
        )
        val request = parsed.value
        if (request == null) {
            call.reject(parsed.error ?: "invalid request", "INVALID")
            return
        }
        onMain(call, noFrame = { call.resolve(JSObject().put("id", JSONObject.NULL)) }) { frame ->
            frame.present(request, token) { id ->
                call.resolve(JSObject().put("id", id ?: JSONObject.NULL))
            }
        }
    }

    @PluginMethod
    fun updatePresented(call: PluginCall) {
        val token = call.getString("token") ?: ""
        val title = call.getString("title")
        val message = call.getString("message")
        onMain(call) { it.updatePresented(token, title, message); call.resolve() }
    }

    @PluginMethod
    fun dismissPresented(call: PluginCall) {
        val token = call.getString("token") ?: ""
        onMain(call) {
            it.dismissPresented(token)
            it.dismissForm(token)
            call.resolve()
        }
    }

    @PluginMethod
    fun presentForm(call: PluginCall) {
        val token = call.getString("token")
        if (token.isNullOrEmpty()) {
            call.reject("presentForm needs a token", "INVALID")
            return
        }
        val parsed = FormSheetRequest.parse(toMap(call.data))
        val request = parsed.value
        if (request == null) {
            call.reject(parsed.error ?: "invalid form", "INVALID")
            return
        }
        onMain(call, noFrame = { call.resolve(JSObject().put("values", JSONObject.NULL)) }) { frame ->
            frame.presentForm(request, token) { values ->
                call.resolve(JSObject().put("values", values?.let { JSObject.wrap(it) } ?: JSONObject.NULL))
            }
        }
    }

    @PluginMethod
    fun setBarTools(call: PluginCall) {
        val data = toMap(call.data)
        val tools = BarTools.parse(
            path = data["path"] as? String,
            menus = data["menus"] as? List<*>,
            search = data["search"] as? Map<*, *>,
        )
        if (tools == null) {
            call.reject("setBarTools needs a path", "INVALID")
            return
        }
        onMain(call) { it.setBarTools(tools); call.resolve() }
    }

    // ---- Events for the web (names and payloads as in config/nativeFrame.ts) --

    override fun tabSelect(tab: String, path: String?, reselect: Boolean) = notifyListeners(
        "tabSelect",
        JSObject().put("tab", tab).put("path", path ?: JSONObject.NULL).put("reselect", reselect),
    )

    override fun back(path: String) = notifyListeners("back", JSObject().put("path", path))

    override fun moreSelect(id: String, path: String?) {
        val data = JSObject().put("id", id)
        if (path != null) data.put("path", path)
        notifyListeners("moreSelect", data)
    }

    override fun rightButton(id: String) = notifyListeners("rightButton", JSObject().put("id", id))

    override fun barMenuSelect(path: String, id: String) =
        notifyListeners("barMenuSelect", JSObject().put("path", path).put("id", id))

    override fun barSearch(path: String, text: String) =
        notifyListeners("barSearch", JSObject().put("path", path).put("text", text))

    private fun onMain(
        call: PluginCall,
        noFrame: () -> Unit = { call.resolve() },
        work: (NativeFrameController) -> Unit,
    ) {
        bridge.executeOnMainThread {
            val current = frame
            if (current == null) noFrame() else work(current)
        }
    }

    companion object {
        /** The bridge's JSON as plain Kotlin maps and lists, for the models. */
        fun toMap(json: JSONObject?): Map<String, Any?> {
            if (json == null) return emptyMap()
            val out = linkedMapOf<String, Any?>()
            val keys = json.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                out[key] = plain(json.opt(key))
            }
            return out
        }

        private fun plain(value: Any?): Any? = when (value) {
            null, JSONObject.NULL -> null
            is JSONObject -> toMap(value)
            is JSONArray -> (0 until value.length()).map { plain(value.opt(it)) }
            else -> value
        }
    }
}
