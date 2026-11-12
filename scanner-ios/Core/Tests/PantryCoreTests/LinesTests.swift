import XCTest
@testable import PantryCore

// The same cases as the Android scanner's (scanner/app/src/test/.../LinesTest.kt), so the two send the same thing.
final class LinesTests: XCTestCase {
    private func json(_ s: String) -> JSON { try! JSONSerialization.jsonObject(with: Data(s.utf8)) as! JSON }

    func testPairingLinks() {
        let l = Site.readPairLink("sintfoap-scanner://pair?site=https%3A%2F%2Fsintfoap.xyz&code=ABCD2345")
        XCTAssertEqual(l?.site, "https://sintfoap.xyz")
        XCTAssertEqual(l?.code, "ABCD2345")
        XCTAssertNil(Site.readPairLink("https://sintfoap.xyz/pantry/"))
        XCTAssertNil(Site.readPairLink("sintfoap-scanner://pair?site=http%3A%2F%2Fevil.example&code=ABCD2345"))   // not https
        XCTAssertNil(Site.readPairLink("sintfoap-scanner://pair?code=ABCD2345"))
    }

    func testSiteAddresses() {
        XCTAssertEqual(Site.cleanSite("sintfoap.xyz/"), "https://sintfoap.xyz")
        XCTAssertEqual(Site.cleanSite("https://sintfoap.xyz/pantry/"), "https://sintfoap.xyz")
        XCTAssertEqual(Site.cleanSite("http://192.168.1.20:8787"), "http://192.168.1.20:8787")
        XCTAssertNil(Site.cleanSite("http://sintfoap.xyz"))
    }

    func testOneMoreOfTheSame() {
        XCTAssertEqual(bump("10 lb", "10 lb"), "20 lb")
        XCTAssertEqual(bump("2", "1"), "3")
        XCTAssertEqual(bump("1 gallon", "0.5 gallon"), "1.5 gallon")
        XCTAssertEqual(bump("10 lb", "2 cups"), "10 lb")
    }

    func testAReceiptLineFromTheSite() {
        let p = json("""
            {"printed":"GV WW FLR 10LB","name":"Whole wheat flour","skip":false,
             "match":{"id":"i_0000000001","name":"Whole wheat flour","kind":"measured","how":"remembered","text":"2 lb"},
             "amount":"10 lb","expires":"2027-02-09","expires_by":"estimated"}
            """)
        let l = Line.from(p, store: "Walmart")
        XCTAssertEqual(l.target, "i_0000000001")
        XCTAssertEqual(l.how, "remembered")
        XCTAssertTrue(l.on)
        let sent = l.toJSON()
        XCTAssertEqual(sent["item"] as? String, "i_0000000001")
        XCTAssertEqual(sent["amount"] as? String, "10 lb")
        XCTAssertEqual(sent["expires_by"] as? String, "estimated")
        XCTAssertNil(sent["kind"])

        let bag = Line.from(json("""
            {"printed":"BAG FEE","name":"Bag","skip":true,"match":null,"new":{"kind":"counted","place":"Cupboard"},"amount":"1","expires":"","expires_by":""}
            """))
        XCTAssertFalse(bag.on)
        XCTAssertTrue(bag.isNew)
        XCTAssertEqual(bag.kind, "counted")
    }

    func testANewBarcodeIsSentAsANewItem() {
        var l = Line()
        l.barcode = "0000000000017"; l.name = "Oat milk"; l.kind = "counted"; l.place = "Fridge"; l.amount = "1"
        l.expires = "2026-11-30"; l.expiresBy = "scanned"
        let sent = l.toJSON()
        XCTAssertEqual(sent["barcode"] as? String, "0000000000017")
        XCTAssertEqual(sent["name"] as? String, "Oat milk")
        XCTAssertEqual(sent["expires_by"] as? String, "scanned")
        XCTAssertNil(sent["item"])
        // It goes as JSON.
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: sent))
    }

    func testAStapleIsSentWithItsLowPoint() {
        var plain = Line(); plain.name = "Oat milk"; plain.kind = "counted"
        XCTAssertEqual(plain.toJSON()["staple"] as? Bool, false)
        XCTAssertNil(plain.toJSON()["low"])
        var soup = Line(); soup.name = "Tomato soup"; soup.kind = "counted"; soup.staple = true; soup.low = "2"
        XCTAssertEqual(soup.toJSON()["low"] as? String, "2")
        // A gauged one is low at a mark: Almost out unless another is picked.
        var vanilla = Line(); vanilla.name = "Vanilla extract"; vanilla.kind = "gauged"; vanilla.staple = true
        XCTAssertEqual(vanilla.toJSON()["low"] as? Int, 1)
        vanilla.lowLevel = 3
        XCTAssertEqual(vanilla.toJSON()["low"] as? Int, 3)
        // Kept to fix, it comes back as it was.
        var cumin = Line(); cumin.name = "Cumin"; cumin.kind = "gauged"; cumin.staple = true; cumin.lowLevel = 2; cumin.level = 1
        let back = Line.fromSent(cumin.toJSON())
        XCTAssertTrue(back.staple)
        XCTAssertEqual(back.lowLevel, 2)
        XCTAssertEqual(back.level, 1)
        XCTAssertEqual(back.key, cumin.key)
        // Also after a trip through a file (the numbers come back as NSNumbers).
        let data = try! JSONSerialization.data(withJSONObject: cumin.toJSON())
        let again = Line.fromSent(try! JSONSerialization.jsonObject(with: data) as! JSON)
        XCTAssertEqual(again.lowLevel, 2)
        XCTAssertEqual(again.level, 1)
        XCTAssertTrue(again.staple)
    }

    func testWhichDatesAreWorthSnapping() {
        let today = Day(year: 2026, month: 11, day: 11)
        func line(_ expires: String, _ by: String) -> Line { var l = Line(); l.expires = expires; l.expiresBy = by; return l }
        XCTAssertTrue(dateMatters(line("2026-11-18", "estimated"), today: today))
        XCTAssertFalse(dateMatters(line("2028-11-10", "estimated"), today: today))
        XCTAssertFalse(dateMatters(line("2026-11-18", "scanned"), today: today))
        XCTAssertEqual(nice("2026-12-09", today: today), "Dec 9")
        XCTAssertEqual(nice("2027-02-09", today: today), "Feb 9, 2027")
        XCTAssertEqual(today.plus(days: 31).text, "2026-12-12")
    }

    func testBarcodesReadAsAndroidReadsThem() {
        XCTAssertEqual(sameBarcode("0012345678905"), "012345678905")   // a UPC-A, as iOS reads it
        XCTAssertEqual(sameBarcode("5000159484695"), "5000159484695")   // an EAN-13
        XCTAssertEqual(sameBarcode("96385074"), "96385074")
        XCTAssertTrue(isBarcode("012345678905"))
        XCTAssertFalse(isBarcode("12345"))
        XCTAssertFalse(isBarcode("sintfoap-scanner://pair"))
    }

    func testItemsFromTheSite() {
        let items = itemsFrom(json("""
            {"items":[{"id":"i_0000000001","name":"Eggs","kind":"counted","text":"3 eggs","place":"Fridge"}]}
            """))
        XCTAssertEqual(items, [Item(id: "i_0000000001", name: "Eggs", kind: "counted", text: "3 eggs", place: "Fridge")])
    }
}

final class OutboxTests: XCTestCase {
    func testWaitsAndKeepsWhatTheSiteWouldNotTake() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let box = Outbox(folder: dir)
        XCTAssertTrue(box.queue().isEmpty)
        box.enqueue(store: "Walmart", lines: [["key": "a", "name": "Flour"], ["key": "b", "name": "Bag"]])
        box.enqueue(store: "", lines: [["key": "c", "name": "Oat milk"]])
        XCTAssertEqual(Outbox(folder: dir).queue().count, 2)        // it's on disk
        let failed = Outbox.failedLines(batch: box.queue()[0], answer: ["failed": [["key": "b", "error": "say how much"]]])
        XCTAssertEqual(failed.count, 1)
        XCTAssertEqual(failed[0]["store"] as? String, "Walmart")
        XCTAssertEqual(failed[0]["error"] as? String, "say how much")
        box.addToFix(failed)
        box.dropFirst()
        XCTAssertEqual(box.queue().first?.str("store"), "")
        XCTAssertEqual(Line.fromSent(box.toFix()[0]).error, "say how much")
        box.dropFirst(); box.clearToFix()
        XCTAssertTrue(box.queue().isEmpty && box.toFix().isEmpty)
    }
}
