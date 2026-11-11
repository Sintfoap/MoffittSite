package xyz.sintfoap.scanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

class DatesTest {
    private val today = LocalDate.of(2026, 11, 11)
    private fun read(s: String) = Dates.expiry(s, today)?.toString()

    @Test fun usNumbers() {
        assertEquals("2027-05-10", read("BEST BY 05/10/27"))
        assertEquals("2027-05-10", read("05-10-2027"))
        assertEquals("2026-12-01", read("USE BY 12.01.26"))
    }

    @Test fun dayFirstWhenItMustBe() {
        assertEquals("2027-12-25", read("BB 25/12/27"))
    }

    @Test fun iso() {
        assertEquals("2027-05-10", read("EXP 2027-05-10 L2341"))
    }

    @Test fun monthNames() {
        assertEquals("2027-05-10", read("EXP 10MAY27"))
        assertEquals("2027-05-10", read("BEST BEFORE 10 MAY 2027"))
        assertEquals("2027-05-10", read("BB MAY 10 2027"))
        assertEquals("2027-05-10", read("Best if used by May 10, 2027"))
        assertEquals("2027-06-30", read("BEST BY JUN 2027"))
        assertEquals("2027-09-30", read("EXP SEPT 27"))
        assertEquals("2027-06-30", read("EXP 06/2027"))
    }

    @Test fun theLabelledOneWinsOverAPackedDate() {
        assertEquals("2026-11-20", read("PACKED 11/09/26  SELL BY 11/20/26"))
        assertEquals("2026-11-20", read("SELL BY 11/20/26 PACKED 12/09/26"))
    }

    @Test fun otherwiseTheLatest() {
        assertEquals("2026-11-20", read("11/09/26 11/20/26"))
    }

    @Test fun cameraMixups() {
        assertEquals("2027-05-10", read("BEST BY O5/1O/27"))
    }

    @Test fun notDates() {
        assertNull(read("NET WT 16 OZ (453g)"))
        assertNull(read("BEST BY 05/10/19"))       // long past
        assertNull(read("LOT 1234 5678"))
        assertNull(read("31/31/27"))
    }
}
