package xyz.sintfoap.scanner

import android.app.DatePickerDialog
import android.content.Intent
import android.net.Uri
import android.view.HapticFeedbackConstants
import androidx.camera.core.ImageCapture
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.io.File
import java.time.LocalDate

@Composable
fun App(s: Scanner) {
    Look {
        Box(Modifier.fillMaxSize().background(Bg).safeDrawingPadding()) {
            when (val sc = s.screen) {
                Screen.Pair -> PairScreen(s)
                Screen.PairCamera -> PairCamera(s)
                Screen.Home -> HomeScreen(s)
                Screen.Receipt -> ReceiptScreen(s)
                Screen.Barcodes -> BarcodeScreen(s)
            }
            s.busy?.let { doing ->
                Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Panel).border(1.dp, Gold).padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = Gold, strokeWidth = 2.dp)
                    Spacer(Modifier.width(12.dp)); Text(doing, color = Ink)
                }
            }
        }
    }
}

@Composable
private fun Said(s: Scanner) {
    s.error?.let { Hint(it, Bad) }
    s.said?.let { Hint(it, Gold) }
}

// ── pairing ──────────────────────────────────────────────────────────────

@Composable
fun PairScreen(s: Scanner) {
    var site by remember { mutableStateOf(s.site?.removePrefix("https://") ?: BuildConfig.DEFAULT_SITE.removePrefix("https://")) }
    var code by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(20.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Kicker("Kitchen"); H1("Pantry scanner")
        Hint("Snap receipts and scan barcodes as you unpack the groceries. Everything goes into your Pantry on the site.")
        Hint("To start, on a computer open Pantry and press Phone scanner. Then scan the code it shows.", Ink)
        Btn("Scan the code", Modifier.fillMaxWidth()) { s.error = null; s.screen = Screen.PairCamera }
        Spacer(Modifier.height(8.dp))
        Hint("Or type it:")
        Field("Site", site, Modifier.fillMaxWidth(), "sintfoap.xyz", KeyboardOptions(keyboardType = KeyboardType.Uri)) { site = it }
        Field("Code", code, Modifier.fillMaxWidth(), "ABCD-EFGH", KeyboardOptions(capitalization = KeyboardCapitalization.Characters)) { code = it }
        Btn("Pair", quiet = true, enabled = code.isNotBlank() && s.busy == null) { s.pair(site, code) }
        Said(s)
    }
}

@Composable
fun PairCamera(s: Scanner) {
    var seen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            CameraView { listOf(barcodeAnalysis(qr = true) { codes ->
                val link = codes.firstOrNull { Site.readPairLink(it) != null }
                if (link != null && !seen) { seen = true; s.pairLink(link) }
            }) }
        }
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Hint("Point the camera at the code on your Pantry page.", Ink)
            Btn("Back", quiet = true) { s.screen = Screen.Pair }
        }
    }
}

// ── the basket ───────────────────────────────────────────────────────────

@Composable
fun HomeScreen(s: Scanner) {
    val context = LocalContext.current
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { s.refresh() }
    Column(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Kicker("Pantry scanner"); H1(if (s.who.isBlank()) "Your pantry" else "${s.who}'s pantry") }
                Box {
                    TextButton({ menu = true }) { Text("⋮", color = Gold, fontSize = 22.sp) }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem({ Text("Paired with ${s.host()}", color = Muted) }, {}, enabled = false)
                        DropdownMenuItem({ Text("Unpair this phone", color = Bad) }, { menu = false; s.unpair() })
                    }
                }
            }
            s.update?.let { (v, url) ->
                Hint("Version $v of the scanner is out. Tap to get it.", Gold)
                    .also { }
                TextButton({ context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }) { Text("[ GET VERSION $v ]", color = Gold) }
            }
            if (s.waiting > 0) Hint("${s.waiting} batch${if (s.waiting == 1) "" else "es"} waiting for a connection; they'll go on their own.", Gold)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Btn("Snap receipt", Modifier.weight(1f)) { s.said = null; s.error = null; s.screen = Screen.Receipt }
                Btn("Scan barcodes", Modifier.weight(1f)) { s.said = null; s.error = null; s.lastScanned = null; s.screen = Screen.Barcodes }
            }
            Said(s)
        }
        if (s.lines.isEmpty()) {
            Column(Modifier.weight(1f).padding(16.dp)) {
                Hint("Start with the receipt: it does most of the work. Then scan the barcode of anything it couldn't make out, or anything bought without one. " +
                    "Expiry dates are estimated; set the real one on anything where it matters.")
            }
        } else {
            LazyColumn(Modifier.weight(1f).padding(horizontal = 16.dp)) {
                items(s.lines, key = { it.key }) { LineCard(s, it) }
                item { Spacer(Modifier.height(90.dp)) }
            }
            val n = s.lines.count { it.on }
            Row(Modifier.fillMaxWidth().background(Panel).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Btn(if (n == 0) "Add to pantry" else "Add $n to pantry", Modifier.weight(1f), enabled = n > 0 && s.busy == null) { s.send() }
                Btn("Clear", quiet = true) { s.clear() }
            }
        }
    }
}

private val HOW = mapOf("remembered" to "remembered from this store", "name" to "matched by name", "barcode" to "known barcode")

@Composable
fun LineCard(s: Scanner, l: Line) {
    val context = LocalContext.current
    val item = s.items.firstOrNull { it.id == l.target }
    val kind = item?.kind ?: l.kind
    var pick by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).border(BorderStroke(1.dp, if (l.error.isNotEmpty()) Bad else Rule)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(l.on, { on -> s.change(l.key) { it.copy(on = on) } }, colors = CheckboxDefaults.colors(checkedColor = Gold, checkmarkColor = Bg, uncheckedColor = Faint))
            Column(Modifier.weight(1f)) {
                if (l.printed.isNotEmpty()) Text(l.printed, color = Faint, fontSize = 12.sp, fontFamily = Mono)
                if (l.barcode.isNotEmpty() && l.printed.isEmpty()) Text("barcode ${l.barcode}", color = Faint, fontSize = 12.sp, fontFamily = Mono)
                Text(l.title, color = if (l.on) Ink else Faint, fontWeight = FontWeight.Bold, fontFamily = Mono)
            }
            TextButton({ s.remove(l.key) }) { Text("×", color = Faint, fontSize = 20.sp) }
        }
        if (l.skip && !l.on) { Hint("Not food, so it's left off. Tick it to add it anyway.", Faint); return@Column }
        if (!l.on) return@Column
        // What it adds to.
        Box {
            Text(if (item != null) "→ ${item.name} (have ${item.text})" else "→ New: ${l.name.ifBlank { "name it below" }}",
                color = if (item != null) Ink else Gold, fontFamily = Mono,
                modifier = Modifier.fillMaxWidth().border(1.dp, Rule).clickable { pick = true }.padding(10.dp))
            DropdownMenu(pick, { pick = false }) {
                DropdownMenuItem({ Text("New: ${l.name.ifBlank { "something new" }}", color = Gold) }, { pick = false; s.change(l.key) { it.copy(target = "") } })
                s.items.forEach { i -> DropdownMenuItem({ Text("${i.name} (have ${i.text})") }, { pick = false; s.change(l.key) { it.copy(target = i.id) } }) }
            }
        }
        Hint(when {
            item != null && l.target == item.id && l.how.isNotEmpty() -> HOW[l.how] ?: "picked"
            item != null -> "picked"
            else -> "new to your pantry"
        }, Faint)
        if (item == null) {
            Field("Name", l.name, Modifier.fillMaxWidth(), "Oat milk", KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)) { v -> s.change(l.key) { it.copy(name = v) } }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((k, label) in listOf("" to "Guess", "staple" to "Staple", "counted" to "Counted", "gauged" to "Gauged")) {
                    val on = l.kind == k
                    Text(label, color = if (on) Bg else Muted, fontFamily = Mono, fontSize = 12.sp,
                        modifier = Modifier.background(if (on) Gold else Bg).border(1.dp, if (on) Gold else Rule).clickable { s.change(l.key) { it.copy(kind = k) } }.padding(horizontal = 8.dp, vertical = 6.dp))
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field("Kept in", l.place, Modifier.weight(1f), "Cupboard") { v -> s.change(l.key) { it.copy(place = v) } }
                if (l.kind == "staple") Field("Low at", l.low, Modifier.weight(1f), "2 lb") { v -> s.change(l.key) { it.copy(low = v) } }
                if (l.kind == "counted") Field("One is a", l.unit, Modifier.weight(1f), "can") { v -> s.change(l.key) { it.copy(unit = v) } }
            }
        }
        if (kind == "gauged") {
            Hint("How full is it?", Muted)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (n in 5 downTo 1) {
                    val on = (l.level ?: 5) == n
                    Text(LEVELS[n], color = if (on) Bg else Muted, fontFamily = Mono, fontSize = 12.sp,
                        modifier = Modifier.background(if (on) Gold else Bg).border(1.dp, if (on) Gold else Rule)
                            .clickable { s.change(l.key) { it.copy(level = n) } }.padding(horizontal = 8.dp, vertical = 6.dp))
                }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Field("How much", l.amount, Modifier.weight(1f), if (kind == "staple") "10 lb" else "2") { v -> s.change(l.key) { it.copy(amount = v, each = v) } }
                Column(Modifier.weight(1f)) {
                    val est = l.expiresBy == "estimated"
                    val pickDate = {
                        val d = runCatching { LocalDate.parse(l.expires) }.getOrNull() ?: LocalDate.now()
                        DatePickerDialog(context, { _, y, m, day -> s.setDate(l.key, LocalDate.of(y, m + 1, day), "typed") }, d.year, d.monthValue - 1, d.dayOfMonth).show()
                    }
                    Text(if (l.expires.isEmpty()) "No expiry date" else "Expires ${nice(l.expires)}" + if (est) " (est.)" else "",
                        color = Ink, fontFamily = Mono, fontSize = 13.sp, modifier = Modifier.clickable { pickDate() })
                    TextButton(pickDate, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
                        Text(if (dateMatters(l)) "[ CHECK THE DATE ]" else if (l.expires.isEmpty()) "set a date" else "change it",
                            color = Gold, fontFamily = Mono, fontSize = 12.sp)
                    }
                }
            }
        }
        if (l.error.isNotEmpty()) Hint(l.error.replaceFirstChar { it.uppercase() }, Bad)
    }
}

// ── the cameras ──────────────────────────────────────────────────────────

@Composable
fun ReceiptScreen(s: Scanner) {
    val context = LocalContext.current
    val capture = remember { ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY).build() }
    val shots = remember { mutableStateListOf<File>() }
    var problem by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) { CameraView { listOf(capture) } }
        Column(Modifier.background(Panel).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Hint(when (shots.size) {
                0 -> "Lay the receipt flat in good light, all of it in the picture. A long one: take it in parts, top to bottom (up to 4)."
                else -> "${shots.size} picture${if (shots.size == 1) "" else "s"}. Take the next part, or read it."
            }, Ink)
            problem?.let { Hint(it, Bad) }
            s.error?.let { Hint(it, Bad) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Btn(if (shots.isEmpty()) "Snap" else "Snap more", Modifier.weight(1f), quiet = shots.isNotEmpty(), enabled = shots.size < 4 && s.busy == null) {
                    snap(context, capture) { f, e -> if (f != null) shots.add(f) else problem = e }
                }
                if (shots.isNotEmpty()) Btn("Read it", Modifier.weight(1f), enabled = s.busy == null) { s.readReceipt(shots.toList()) }
            }
            Btn("Back", quiet = true) { shots.forEach { it.delete() }; s.screen = Screen.Home }
        }
    }
}

@Composable
fun BarcodeScreen(s: Scanner) {
    val view = LocalView.current
    var last by remember { mutableStateOf("" to 0L) }
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            CameraView { listOf(barcodeAnalysis(qr = false) { codes ->
                val code = codes.firstOrNull() ?: return@barcodeAnalysis
                val now = System.currentTimeMillis()
                // The same code stays in view: once, until it's been away (or 2.5 s pass, for one more of the same).
                if (code == last.first && now - last.second < 2500) { last = code to now; return@barcodeAnalysis }
                last = code to now
                view.post { view.performHapticFeedback(HapticFeedbackConstants.CONFIRM); s.scanned(code) }
            }) }
            Box(Modifier.align(Alignment.Center).fillMaxWidth(0.8f).height(2.dp).background(Gold))
        }
        Column(Modifier.background(Panel).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Hint(s.lastScanned ?: "Point it at a barcode. Each one goes in your list to check; scan the same thing again for one more.", Ink)
            s.error?.let { Hint(it, Bad) }
            Hint("${s.lines.count { it.barcode.isNotEmpty() }} scanned so far", Faint)
            Btn("Done", Modifier.fillMaxWidth()) { s.error = null; s.screen = Screen.Home }
        }
    }
}
