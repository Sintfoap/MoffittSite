package xyz.sintfoap.scanner

import android.app.Application
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The screens as they're drawn, with a basket from a receipt and a barcode; pictures go to scanner/app/screens/. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreensTest {
    @get:Rule val compose = createComposeRule()
    private fun scanner() = Scanner(ApplicationProvider.getApplicationContext<Application>())

    @Test fun pairing() {
        val s = scanner()
        s.screen = Screen.Pair
        compose.setContent { App(s) }
        compose.onNodeWithText("[ SCAN THE CODE ]").assertExists()
        compose.onRoot().captureRoboImage("screens/pair.png")
    }

    @Test fun checkingTheBasket() {
        val s = scanner()
        s.screen = Screen.Home
        s.who = "Ryan M"
        s.items = listOf(Item("i_0000000001", "Whole wheat flour", "staple", "2 lb", "Cupboard"),
            Item("i_0000000002", "Eggs", "counted", "3 eggs", "Fridge"), Item("i_0000000003", "Ground cumin", "gauged", "Almost out", "Spice rack"))
        s.said = "Read 5 lines from the Walmart receipt (by Claude). New ones are marked; scan a barcode or check the name."
        s.lines.addAll(listOf(
            Line(store = "Walmart", printed = "GV WW FLR 10LB", name = "Whole wheat flour", target = "i_0000000001", how = "remembered", amount = "10 lb", expires = "2027-02-09", expiresBy = "estimated"),
            Line(store = "Walmart", printed = "GV WHL MLK GAL", name = "Whole milk", kind = "staple", place = "Fridge", amount = "1 gallon", expires = "2026-11-18", expiresBy = "estimated"),
            Line(store = "Walmart", printed = "MCCORM CUMIN", name = "Ground cumin", target = "i_0000000003", how = "name"),
            Line(store = "Walmart", printed = "BAG FEE", name = "Bag", on = false, skip = true),
            Line(barcode = "0000000000017", amount = "1", error = "give it a name, like Whole wheat flour"),
        ))
        compose.setContent { App(s) }
        compose.onNodeWithText("[ ADD 4 TO PANTRY ]").assertExists()
        compose.onRoot().captureRoboImage("screens/basket.png")
    }

    @Test fun empty() {
        val s = scanner()
        s.screen = Screen.Home
        s.who = "Ryan M"
        compose.setContent { App(s) }
        compose.onRoot().captureRoboImage("screens/home.png")
    }
}
