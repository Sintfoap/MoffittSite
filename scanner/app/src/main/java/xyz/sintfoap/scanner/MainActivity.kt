package xyz.sintfoap.scanner

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
    private val scanner: Scanner by viewModels()

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        enableEdgeToEdge()
        if (saved == null) opened(intent)
        setContent {
            BackHandler(enabled = scanner.screen != Screen.Home && scanner.screen != Screen.Pair) {
                scanner.screen = if (scanner.screen == Screen.PairCamera) Screen.Pair else Screen.Home
            }
            App(scanner)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        opened(intent)
    }

    /** Opened from the pairing QR code by the phone's own camera app: pair straight away. */
    private fun opened(intent: Intent?) {
        val link = intent?.data?.toString() ?: return
        scanner.pairLink(link)
    }
}
