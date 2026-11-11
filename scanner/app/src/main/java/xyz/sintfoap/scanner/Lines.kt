package xyz.sintfoap.scanner

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID

/** Something in your pantry, to add to: from GET /pantry/api/items. */
data class Item(val id: String, val name: String, val kind: String, val text: String, val place: String)

fun itemsFrom(json: JSONObject): List<Item> {
    val a = json.optJSONArray("items") ?: JSONArray()
    return (0 until a.length()).map { a.getJSONObject(it) }.map {
        Item(it.getString("id"), it.getString("name"), it.getString("kind"), it.optString("text"), it.optString("place"))
    }
}

/**
 * One thing to add, from a receipt line or a barcode, checked before it's
 * sent: what it adds to (an item you have, or new), how much, and when it
 * expires. Shaped like the site's receipt lines (src/pantry_receipt.js).
 */
data class Line(
    val key: String = UUID.randomUUID().toString().take(12),
    val store: String = "",          // the receipt's store, for remembering its abbreviations ("" for a barcode)
    val printed: String = "",        // as the receipt printed it
    val barcode: String = "",
    val name: String = "",
    val brand: String = "",
    val target: String = "",         // an item's id, or "" for new
    val how: String = "",            // how it was matched: remembered, name, barcode
    val kind: String = "",           // for a new one: measured, counted, gauged ("" lets the site guess from the name)
    val staple: Boolean = false,     // for a new one: kept stocked, with a point it's running low at
    val place: String = "",
    val unit: String = "",
    val size: String = "",
    val low: String = "",            // a staple's low point: "2 lb", or how many
    val lowLevel: Int? = null,       // a gauged staple's: the mark it's low at, 0 (empty) to 4 (¾ left); null is Almost out
    val amount: String = "",
    val each: String = "",           // how much one more of it adds (a barcode scanned again)
    val expires: String = "",        // YYYY-MM-DD
    val expiresBy: String = "",      // estimated, typed
    val level: Int? = null,          // a gauged thing: how full, 0 (empty) to 5 (full); null is full
    val on: Boolean = true,
    val skip: Boolean = false,       // not food (a bag, tax): starts unticked
    val error: String = "",
) {
    val isNew get() = target.isEmpty()
    val title get() = name.ifBlank { printed }.ifBlank { "Something unnamed" }

    /** As the site's /pantry/api/add takes it. */
    fun toJson(): JSONObject {
        val o = JSONObject().put("key", key).put("printed", printed).put("amount", amount)
            .put("expires", expires).put("expires_by", if (expires.isEmpty()) "" else expiresBy)
        if (level != null) o.put("level", level)
        if (barcode.isNotEmpty()) o.put("barcode", barcode).put("size", size).put("brand", brand)
        if (!isNew) return o.put("item", target).put("name", name)
        o.put("name", name).put("kind", kind).put("place", place).put("unit", unit).put("size", size).put("staple", staple)
        if (staple) o.put("low", if (kind == "gauged") (lowLevel ?: 1) else low)
        return o
    }

    companion object {
        /** A proposal from the site (a receipt's line, or a barcode's). */
        fun from(p: JSONObject, store: String = "", barcode: String = "", brand: String = ""): Line {
            val match = p.optJSONObject("match")
            val new = p.optJSONObject("new") ?: JSONObject()
            val amount = p.optString("amount")
            return Line(
                store = store, printed = p.optString("printed"), barcode = barcode, name = p.optString("name"), brand = brand,
                target = match?.optString("id") ?: "", how = match?.optString("how") ?: "",
                kind = new.optString("kind").let { if (it == "staple") "measured" else it }, place = new.optString("place"), unit = new.optString("unit"), size = new.optString("size", p.optString("size")),
                amount = amount, each = amount, expires = p.optString("expires"), expiresBy = p.optString("expires_by"),
                on = !p.optBoolean("skip"), skip = p.optBoolean("skip"),
            )
        }

        /** A line kept to fix (Store.toFix): what was sent, with the site's error. */
        fun fromSent(o: JSONObject) = Line(
            key = o.optString("key"), store = o.optString("store"), printed = o.optString("printed"), barcode = o.optString("barcode"),
            name = o.optString("name"), brand = o.optString("brand"), target = o.optString("item"), kind = o.optString("kind"),
            place = o.optString("place"), unit = o.optString("unit"), size = o.optString("size"),
            staple = o.optBoolean("staple"), low = if (o.optString("kind") == "gauged") "" else o.optString("low"),
            lowLevel = if (o.optString("kind") == "gauged" && o.has("low")) o.optInt("low") else null,
            amount = o.optString("amount"), each = o.optString("amount"), expires = o.optString("expires"), expiresBy = o.optString("expires_by"),
            level = if (o.has("level")) o.optInt("level") else null, error = o.optString("error"),
        )
    }
}

/** One more of the same thing: "10 lb" and "10 lb" make "20 lb"; "2" and "1" make "3". Otherwise as it was. */
fun bump(amount: String, each: String): String {
    val re = Regex("^\\s*(\\d+(?:\\.\\d+)?)\\s*(.*)$")
    val a = re.find(amount) ?: return amount
    val b = re.find(each) ?: return amount
    if (a.groupValues[2].trim().lowercase() != b.groupValues[2].trim().lowercase()) return amount
    val n = a.groupValues[1].toDouble() + b.groupValues[1].toDouble()
    val s = if (n == Math.floor(n)) n.toLong().toString() else "%.3f".format(n).trimEnd('0').trimEnd('.')
    return (s + " " + a.groupValues[2].trim()).trim()
}

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
/** 2026-12-09 → "Dec 9" (with the year when it isn't this one). */
fun nice(day: String, today: LocalDate = LocalDate.now()): String {
    val d = try { LocalDate.parse(day) } catch (e: Exception) { return day }
    return "${MONTHS[d.monthValue - 1]} ${d.dayOfMonth}" + if (d.year != today.year) ", ${d.year}" else ""
}

/** How full a gauged thing is, by level. */
val LEVELS = listOf("Empty", "Almost out", "¼ left", "½ left", "¾ left", "Full")

/** Whether an estimated date is close enough that the real one is worth checking (milk, meat, bread). */
fun dateMatters(l: Line, today: LocalDate = LocalDate.now()): Boolean {
    if (l.expiresBy != "estimated" || l.expires.isEmpty()) return false
    val d = try { LocalDate.parse(l.expires) } catch (e: Exception) { return false }
    return d.isBefore(today.plusDays(31))
}
