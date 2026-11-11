package xyz.sintfoap.scanner

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder

/** The site's answer was an error: its message, as the site said it. */
class SiteError(message: String, val status: Int) : Exception(message)

/** This phone's key was unpaired (or its owner lost Pantry): pair again. */
class Unpaired(message: String) : Exception(message)

/**
 * The site's Pantry API (src/pantry.js, src/pantry_scanner.js), as this phone's
 * pairing. Every call blocks; call them off the main thread. An IOException
 * means no connection; SiteError, the site said no.
 */
class Site(val origin: String, private val key: String?) {
    fun call(method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 30_000): JSONObject {
        val c = URL(origin + path).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 15_000
            c.readTimeout = timeoutMs
            c.setRequestProperty("Accept", "application/json")
            c.setRequestProperty("User-Agent", "pantry-scanner/${BuildConfig.VERSION_CODE}")
            if (key != null) c.setRequestProperty("Authorization", "Bearer $key")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = c.responseCode
            val text = (if (status < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (status == 401 && key != null) throw Unpaired(json.optString("error", "this phone isn't paired any more"))
            if (status >= 400) throw SiteError(json.optString("error", "the site answered $status"), status)
            return json
        } finally {
            c.disconnect()
        }
    }

    fun items(day: String) = call("GET", "/pantry/api/items?day=$day")
    fun barcode(code: String, day: String) = call("GET", "/pantry/api/barcode/$code?day=$day")
    fun receipt(images: List<String>, day: String): JSONObject {
        val list = JSONArray().apply { images.forEach { put(JSONObject().put("data", it)) } }
        return call("POST", "/pantry/api/receipt?day=$day", JSONObject().put("images", list), timeoutMs = 180_000)
    }
    fun add(store: String, lines: JSONArray) = call("POST", "/pantry/api/add", JSONObject().put("store", store).put("lines", lines), timeoutMs = 60_000)
    fun latest() = call("GET", "/pantry/scanner/latest.json")

    companion object {
        /** A pairing code (from the QR code, or typed) for this phone's key. */
        fun pair(origin: String, code: String, name: String): JSONObject =
            Site(origin, null).call("POST", "/pantry/scanner/pair", JSONObject().put("code", code).put("name", name))

        /** What a pairing QR code says: (site, code), or null if it isn't one. */
        fun readPairLink(text: String): Pair<String, String>? {
            val uri = try { URI(text.trim()) } catch (e: Exception) { return null }
            if (uri.scheme != "sintfoap-scanner" || uri.host != "pair") return null
            val q = (uri.rawQuery ?: "").split("&").mapNotNull { p ->
                val i = p.indexOf('='); if (i < 0) null else p.substring(0, i) to java.net.URLDecoder.decode(p.substring(i + 1), "UTF-8")
            }.toMap()
            val site = cleanSite(q["site"] ?: return null) ?: return null
            val code = q["code"]?.takeIf { it.isNotBlank() } ?: return null
            return site to code
        }

        /** "sintfoap.xyz" or "https://sintfoap.xyz/" → "https://sintfoap.xyz"; plain http only for a computer on this network (testing). */
        fun cleanSite(raw: String): String? {
            val s = raw.trim().trimEnd('/').let { if ("://" in it) it else "https://$it" }
            val u = try { URI(s) } catch (e: Exception) { return null }
            val host = u.host ?: return null
            val local = host == "localhost" || host == "10.0.2.2" || host.startsWith("192.168.") || host.startsWith("10.")
            if (u.scheme != "https" && !(u.scheme == "http" && local)) return null
            return "${u.scheme}://$host" + (if (u.port > 0) ":${u.port}" else "")
        }

        fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
    }
}

/** What stays on the phone: the pairing, and additions waiting for a connection. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("pantry", Context.MODE_PRIVATE)
    private val queueFile = File(context.filesDir, "queue.json")
    private val fixFile = File(context.filesDir, "to-fix.json")

    val site: String? get() = prefs.getString("site", null)
    val key: String? get() = prefs.getString("key", null)
    val who: String get() = prefs.getString("who", "") ?: ""
    val paired get() = site != null && key != null
    fun api() = Site(site ?: throw Unpaired("not paired"), key ?: throw Unpaired("not paired"))

    fun pairWith(site: String, key: String, who: String) = prefs.edit().putString("site", site).putString("key", key).putString("who", who).apply()
    fun unpair() = prefs.edit().remove("key").remove("who").apply()

    /** Batches to send: [{store, lines}], oldest first. */
    @Synchronized fun queue(): JSONArray = try { JSONArray(queueFile.readText()) } catch (e: Exception) { JSONArray() }
    @Synchronized fun setQueue(q: JSONArray) { if (q.length() == 0) queueFile.delete() else queueFile.writeText(q.toString()) }
    @Synchronized fun enqueue(store: String, lines: JSONArray) = setQueue(queue().put(JSONObject().put("store", store).put("lines", lines)))

    /** Lines the site wouldn't take when they were sent later, each with its error, to fix in the app. */
    @Synchronized fun toFix(): JSONArray = try { JSONArray(fixFile.readText()) } catch (e: Exception) { JSONArray() }
    @Synchronized fun addToFix(lines: List<JSONObject>) { val a = toFix(); lines.forEach { a.put(it) }; fixFile.writeText(a.toString()) }
    @Synchronized fun clearToFix() { fixFile.delete() }
}

fun isOffline(e: Throwable) = e is IOException
