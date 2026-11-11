package xyz.sintfoap.scanner

import android.app.Application
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import java.time.LocalDate

sealed class Screen {
    data object Home : Screen()
    data object Pair : Screen()
    data object PairCamera : Screen()
    data object Receipt : Screen()
    data object Barcodes : Screen()
    data class Date(val key: String) : Screen()
}

/**
 * Everything the app is doing: the pairing, what's in the pantry (to add to),
 * and the basket of lines being checked before they're sent.
 */
class Scanner(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    var screen by mutableStateOf<Screen>(if (store.paired) Screen.Home else Screen.Pair)
    var who by mutableStateOf(store.who)
    val site get() = store.site
    var items by mutableStateOf<List<Item>>(emptyList())
    val lines = mutableStateListOf<Line>()
    var busy by mutableStateOf<String?>(null)
    var said by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var waiting by mutableStateOf(0)
    var update by mutableStateOf<Pair<Int, String>?>(null)   // a newer version, and where to get it
    var lastScanned by mutableStateOf<String?>(null)
    private var checkedUpdate = false

    private fun day() = LocalDate.now().toString()
    private fun ctx() = getApplication<Application>()

    private fun work(doing: String?, block: suspend () -> Unit) {
        viewModelScope.launch {
            busy = doing; error = null
            try { block() }
            catch (e: Unpaired) { store.unpair(); who = ""; screen = Screen.Pair; error = "This phone was unpaired from your pantry. Pair it again from the Pantry page." }
            catch (e: Exception) { error = if (isOffline(e)) "No connection to ${host()}." else (e.message ?: "Something went wrong.").replaceFirstChar { it.uppercase() } }
            finally { busy = null }
        }
    }
    private suspend fun <T> io(f: () -> T): T = withContext(Dispatchers.IO) { f() }
    fun host() = (store.site ?: "").removePrefix("https://").removePrefix("http://")

    // ── pairing ──────────────────────────────────────────────────────────

    fun pair(site: String, code: String) = work("Pairing…") {
        val clean = Site.cleanSite(site) ?: throw Exception("That isn't a site address, like sintfoap.xyz.")
        val out = io { Site.pair(clean, code, Build.MODEL ?: "Phone") }
        store.pairWith(out.getString("site").ifBlank { clean }, out.getString("key"), out.optString("display_name", out.optString("username")))
        who = store.who
        screen = Screen.Home
        said = "Paired with ${who}'s pantry."
        refresh()
    }

    fun pairLink(text: String): Boolean {
        val (site, code) = Site.readPairLink(text) ?: return false
        pair(site, code)
        return true
    }

    fun unpair() { store.unpair(); who = ""; lines.clear(); screen = Screen.Pair }

    // ── the pantry and the basket ────────────────────────────────────────

    fun refresh() = work(null) {
        if (!store.paired) return@work
        items = itemsFrom(io { store.api().items(day()) })
        // Anything sent later that the site wouldn't take comes back to fix.
        val fix = store.toFix()
        if (fix.length() > 0) {
            lines.addAll((0 until fix.length()).map { Line.fromSent(fix.getJSONObject(it)) }.filter { l -> lines.none { it.key == l.key } })
            store.clearToFix()
        }
        waiting = store.queue().length()
        if (waiting > 0) Sender.later(ctx())
        if (!checkedUpdate) {
            checkedUpdate = true
            try {
                val latest = io { store.api().latest() }
                val v = latest.optInt("version", 0)
                if (v > BuildConfig.VERSION_CODE) update = v to latest.optString("url")
            } catch (e: Exception) { /* no update check today */ }
        }
    }

    fun change(key: String, f: (Line) -> Line) {
        val i = lines.indexOfFirst { it.key == key }
        if (i >= 0) lines[i] = f(lines[i]).copy(error = "")
    }
    fun remove(key: String) { lines.removeAll { it.key == key } }
    fun clear() { lines.clear(); said = null; error = null }

    fun readReceipt(files: List<File>) = work("Reading the receipt…") {
        val out = io { store.api().receipt(files.map { shrunk(it) }, day()) }
        files.forEach { it.delete() }
        val shop = out.optString("store")
        val got = out.optJSONArray("lines") ?: JSONArray()
        val read = (0 until got.length()).map { Line.from(got.getJSONObject(it), store = shop) }
        lines.addAll(read)
        screen = Screen.Home
        val by = if (out.optString("by") == "claude") "Claude" else "the site's AI"
        said = "Read ${read.size} lines from the ${shop.ifBlank { "" }} receipt (by $by).".replace("  ", " ")
            .plus(if (read.any { it.isNew && !it.skip }) " New ones are marked; scan a barcode or check the name." else "")
    }

    /** A barcode the camera read: looked up, then added to the basket (or one more of it). */
    fun scanned(code: String) {
        if (!Regex("^\\d{6,14}$").matches(code)) return
        val have = lines.indexOfLast { it.barcode == code }
        if (have >= 0) {
            val l = lines[have]
            lines[have] = l.copy(amount = bump(l.amount, l.each.ifBlank { "1" }))
            lastScanned = "One more ${l.title}: ${lines[have].amount}"
            return
        }
        work("Looking it up…") {
            val out = io { store.api().barcode(code, day()) }
            val product = out.optJSONObject("product")
            val line = out.optJSONObject("line")
            val l = if (product != null && line != null) Line.from(line, barcode = code, brand = product.optString("brand"))
                .copy(size = product.optString("size").ifBlank { line.optJSONObject("new")?.optString("size") ?: "" })
                else Line(barcode = code, amount = "1", each = "1")   // nobody knows it: you name it, once
            lines.add(l)
            lastScanned = if (product == null) "New barcode: name it in the list" else "${l.title}" + (if (l.amount.isNotBlank()) ": ${l.amount}" else "")
        }
    }

    fun setDate(key: String, date: LocalDate?, by: String) {
        change(key) { it.copy(expires = date?.toString() ?: "", expiresBy = if (date == null) "" else by) }
    }

    /** Sends the ticked lines; what the site won't take stays with its reason. No connection: they wait on the phone. */
    fun send() = work("Adding to your pantry…") {
        val ticked = lines.filter { it.on }
        if (ticked.isEmpty()) return@work
        val unnamed = ticked.firstOrNull { it.isNew && it.name.isBlank() }
        if (unnamed != null) throw Exception("Give the new barcode a name first (${unnamed.barcode}).")
        val added = mutableListOf<String>(); val tickedOff = mutableListOf<String>(); var queued = 0
        for ((shop, group) in ticked.groupBy { it.store }) {
            val batch = JSONArray().apply { group.forEach { put(it.toJson()) } }
            try {
                val out = io { store.api().add(shop, batch) }
                val failed = out.optJSONArray("failed") ?: JSONArray()
                val why = (0 until failed.length()).associate { failed.getJSONObject(it).let { f -> f.optString("key") to f.optString("error") } }
                val a = out.optJSONArray("added") ?: JSONArray()
                for (i in 0 until a.length()) added += a.getJSONObject(i).optString("name")
                val t = out.optJSONArray("ticked") ?: JSONArray()
                for (i in 0 until t.length()) tickedOff += t.getJSONObject(i).optString("title")
                for (l in group) {
                    val e = why[l.key]
                    if (e == null) remove(l.key)
                    else lines.indexOfFirst { it.key == l.key }.takeIf { it >= 0 }?.let { lines[it] = lines[it].copy(error = e) }
                }
            } catch (e: Exception) {
                if (!isOffline(e)) throw e
                io { store.enqueue(shop, batch) }
                group.forEach { remove(it.key) }
                queued += group.size
            }
        }
        if (queued > 0) Sender.later(ctx())
        waiting = store.queue().length()
        if (added.isNotEmpty()) items = itemsFrom(io { store.api().items(day()) })
        said = listOfNotNull(
            if (added.isNotEmpty()) "Added ${added.size}: ${added.joinToString(", ")}." else null,
            if (tickedOff.isNotEmpty()) "Ticked off your shopping list: ${tickedOff.joinToString(", ")}." else null,
            if (queued > 0) "No connection, so $queued will go when there is one." else null,
            lines.count { it.error.isNotEmpty() }.takeIf { it > 0 }?.let { "$it still need${if (it == 1) "s" else ""} a fix." },
        ).joinToString(" ")
    }
}
