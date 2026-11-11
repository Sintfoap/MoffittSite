package xyz.sintfoap.scanner

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class LinesTest {
    @Test fun pairingLinks() {
        assertEquals("https://sintfoap.xyz" to "ABCD2345", Site.readPairLink("sintfoap-scanner://pair?site=https%3A%2F%2Fsintfoap.xyz&code=ABCD2345"))
        assertNull(Site.readPairLink("https://sintfoap.xyz/pantry/"))
        assertNull(Site.readPairLink("sintfoap-scanner://pair?site=http%3A%2F%2Fevil.example&code=ABCD2345"))   // not https
        assertNull(Site.readPairLink("sintfoap-scanner://pair?code=ABCD2345"))
    }

    @Test fun siteAddresses() {
        assertEquals("https://sintfoap.xyz", Site.cleanSite("sintfoap.xyz/"))
        assertEquals("https://sintfoap.xyz", Site.cleanSite("https://sintfoap.xyz/pantry/"))
        assertEquals("http://192.168.1.20:8787", Site.cleanSite("http://192.168.1.20:8787"))
        assertNull(Site.cleanSite("http://sintfoap.xyz"))
    }

    @Test fun oneMoreOfTheSame() {
        assertEquals("20 lb", bump("10 lb", "10 lb"))
        assertEquals("3", bump("2", "1"))
        assertEquals("1.5 gallon", bump("1 gallon", "0.5 gallon"))
        assertEquals("10 lb", bump("10 lb", "2 cups"))
    }

    @Test fun aReceiptLineFromTheSite() {
        val p = JSONObject("""{"printed":"GV WW FLR 10LB","name":"Whole wheat flour","skip":false,
            "match":{"id":"i_0000000001","name":"Whole wheat flour","kind":"staple","how":"remembered","text":"2 lb"},
            "amount":"10 lb","expires":"2027-02-09","expires_by":"estimated"}""")
        val l = Line.from(p, store = "Walmart")
        assertEquals("i_0000000001", l.target)
        assertEquals("remembered", l.how)
        assertTrue(l.on)
        val sent = l.toJson()
        assertEquals("i_0000000001", sent.getString("item"))
        assertEquals("10 lb", sent.getString("amount"))
        assertEquals("estimated", sent.getString("expires_by"))
        assertFalse(sent.has("kind"))

        val bag = Line.from(JSONObject("""{"printed":"BAG FEE","name":"Bag","skip":true,"match":null,"new":{"kind":"counted","place":"Cupboard"},"amount":"1","expires":"","expires_by":""}"""))
        assertFalse(bag.on)
        assertTrue(bag.isNew)
    }

    @Test fun aNewBarcodeIsSentAsANewItem() {
        val l = Line(barcode = "0000000000017", name = "Oat milk", kind = "counted", place = "Fridge", amount = "1", expires = "2026-11-30", expiresBy = "scanned")
        val sent = l.toJson()
        assertEquals("0000000000017", sent.getString("barcode"))
        assertEquals("Oat milk", sent.getString("name"))
        assertEquals("scanned", sent.getString("expires_by"))
        assertFalse(sent.has("item"))
    }

    @Test fun whichDatesAreWorthSnapping() {
        val today = LocalDate.of(2026, 11, 11)
        assertTrue(dateMatters(Line(expires = "2026-11-18", expiresBy = "estimated"), today))
        assertFalse(dateMatters(Line(expires = "2028-11-10", expiresBy = "estimated"), today))
        assertFalse(dateMatters(Line(expires = "2026-11-18", expiresBy = "scanned"), today))
        assertEquals("Dec 9", nice("2026-12-09", today))
        assertEquals("Feb 9, 2027", nice("2027-02-09", today))
    }
}
