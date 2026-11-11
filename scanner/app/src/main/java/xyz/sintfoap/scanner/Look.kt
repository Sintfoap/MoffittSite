package xyz.sintfoap.scanner

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The site's console look: gold on green-black, in a monospace face.
val Bg = Color(0xFF0B110D)
val Panel = Color(0xFF121A15)
val Gold = Color(0xFFE0B25A)
val Ink = Color(0xFFE8E4D8)
val Muted = Color(0xFF9AA393)
val Faint = Color(0xFF6A7266)
val Bad = Color(0xFFE06C5A)
val Rule = Color(0xFF2A3A2F)
val Mono = FontFamily.Monospace

@Composable
fun Look(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(primary = Gold, onPrimary = Bg, background = Bg, surface = Panel, onSurface = Ink, onBackground = Ink,
            secondary = Gold, outline = Rule, error = Bad, surfaceVariant = Panel, onSurfaceVariant = Muted),
        typography = MaterialTheme.typography.copy(
            bodyLarge = TextStyle(fontFamily = Mono, fontSize = 15.sp),
            bodyMedium = TextStyle(fontFamily = Mono, fontSize = 14.sp),
            bodySmall = TextStyle(fontFamily = Mono, fontSize = 12.sp, color = Muted),
            labelLarge = TextStyle(fontFamily = Mono, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp),
        ),
        content = content,
    )
}

@Composable
fun Kicker(text: String) = Text(text.uppercase().toCharArray().joinToString(" "), color = Gold, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 12.sp)

@Composable
fun H1(text: String) = Text(text, color = Ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 22.sp)

@Composable
fun Hint(text: String, color: Color = Muted) = Text(text, color = color, fontFamily = Mono, fontSize = 13.sp, lineHeight = 19.sp)

/** The site's [ BUTTON ]: gold, or quiet (outlined). */
@Composable
fun Btn(text: String, modifier: Modifier = Modifier, quiet: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val label = @Composable {
        Text("[ ${text.uppercase()} ]", color = if (!enabled) Faint else if (quiet) Gold else Bg, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 13.sp, letterSpacing = 1.sp)
    }
    val pad = PaddingValues(horizontal = 14.dp, vertical = 10.dp)
    if (quiet) OutlinedButton(onClick, modifier, enabled, shape = androidx.compose.foundation.shape.RoundedCornerShape(0.dp),
        border = BorderStroke(1.dp, Rule), colors = ButtonDefaults.outlinedButtonColors(contentColor = Gold), contentPadding = pad) { label() }
    else Button(onClick, modifier, enabled, shape = androidx.compose.foundation.shape.RoundedCornerShape(0.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Bg, disabledContainerColor = Rule), contentPadding = pad) { label() }
}

@Composable
fun Field(label: String, value: String, modifier: Modifier = Modifier, placeholder: String = "", keyboard: KeyboardOptions = KeyboardOptions.Default, onChange: (String) -> Unit) {
    OutlinedTextField(value, onChange, modifier, label = { Text(label, fontFamily = Mono, fontSize = 12.sp) },
        placeholder = { Text(placeholder, fontFamily = Mono, color = Faint) }, singleLine = true, keyboardOptions = keyboard,
        textStyle = TextStyle(fontFamily = Mono, fontSize = 15.sp, color = Ink),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(0.dp),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Gold, unfocusedBorderColor = Rule, focusedLabelColor = Gold, unfocusedLabelColor = Muted, cursorColor = Gold))
}
