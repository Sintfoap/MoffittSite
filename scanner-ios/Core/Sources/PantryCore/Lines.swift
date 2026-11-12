import Foundation

/// A JSON object as the site sends it.
public typealias JSON = [String: Any]

extension Dictionary where Key == String, Value == Any {
    public func str(_ k: String, _ fallback: String = "") -> String {
        if let s = self[k] as? String { return s }
        if let i = self[k] as? Int { return String(i) }
        if let n = self[k] as? NSNumber { return n.stringValue }
        return fallback
    }
    public func obj(_ k: String) -> JSON? { self[k] as? JSON }
    public func list(_ k: String) -> [JSON] { self[k] as? [JSON] ?? [] }
    public func bool(_ k: String) -> Bool { (self[k] as? Bool) ?? ((self[k] as? NSNumber)?.boolValue ?? false) }
    public func int(_ k: String) -> Int? {
        if let i = self[k] as? Int { return i }
        if let n = self[k] as? NSNumber { return n.intValue }
        if let s = self[k] as? String { return Int(s) }
        return nil
    }
}

/// Something in your pantry, to add to: from GET /pantry/api/items.
public struct Item: Identifiable, Equatable {
    public let id: String, name: String, kind: String, text: String, place: String
    public init(id: String, name: String, kind: String, text: String, place: String) {
        self.id = id; self.name = name; self.kind = kind; self.text = text; self.place = place
    }
}

public func itemsFrom(_ json: JSON) -> [Item] {
    json.list("items").compactMap { o in
        guard let id = o["id"] as? String, let name = o["name"] as? String else { return nil }
        return Item(id: id, name: name, kind: o.str("kind"), text: o.str("text"), place: o.str("place"))
    }
}

/// One thing to add, from a receipt line or a barcode, checked before it's
/// sent: what it adds to (an item you have, or new), how much, and when it
/// expires. Shaped like the site's receipt lines (src/pantry_receipt.js), the
/// same as the Android scanner's (scanner/.../Lines.kt).
public struct Line: Identifiable, Equatable {
    public var key: String = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12))
    public var store = ""        // the receipt's store, for remembering its abbreviations ("" for a barcode)
    public var printed = ""      // as the receipt printed it
    public var barcode = ""
    public var name = ""
    public var brand = ""
    public var target = ""       // an item's id, or "" for new
    public var how = ""          // how it was matched: remembered, name, barcode
    public var kind = ""         // for a new one: measured, counted, gauged ("" lets the site guess from the name)
    public var staple = false    // for a new one: kept stocked, with a point it's running low at
    public var place = ""
    public var unit = ""
    public var size = ""
    public var low = ""          // a staple's low point: "2 lb", or how many
    public var lowLevel: Int? = nil  // a gauged staple's: the mark it's low at, 0 (empty) to 4 (¾ left); nil is Almost out
    public var amount = ""
    public var each = ""         // how much one more of it adds (a barcode scanned again)
    public var expires = ""      // YYYY-MM-DD
    public var expiresBy = ""    // estimated, typed
    public var level: Int? = nil // a gauged thing: how full, 0 (empty) to 5 (full); nil is full
    public var on = true
    public var skip = false      // not food (a bag, tax): starts unticked
    public var error = ""

    public init() {}

    public var id: String { key }
    public var isNew: Bool { target.isEmpty }
    public var title: String {
        if !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        if !printed.trimmingCharacters(in: .whitespaces).isEmpty { return printed }
        return "Something unnamed"
    }

    /// As the site's /pantry/api/add takes it.
    public func toJSON() -> JSON {
        var o: JSON = ["key": key, "printed": printed, "amount": amount, "expires": expires,
                       "expires_by": expires.isEmpty ? "" : expiresBy]
        if let level { o["level"] = level }
        if !barcode.isEmpty { o["barcode"] = barcode; o["size"] = size; o["brand"] = brand }
        if !isNew { o["item"] = target; o["name"] = name; return o }
        o["name"] = name; o["kind"] = kind; o["place"] = place; o["unit"] = unit; o["size"] = size; o["staple"] = staple
        if staple { o["low"] = kind == "gauged" ? (lowLevel ?? 1) as Any : low as Any }
        return o
    }

    /// A proposal from the site (a receipt's line, or a barcode's).
    public static func from(_ p: JSON, store: String = "", barcode: String = "", brand: String = "") -> Line {
        let match = p.obj("match")
        let new = p.obj("new") ?? [:]
        var l = Line()
        l.store = store; l.printed = p.str("printed"); l.barcode = barcode; l.name = p.str("name"); l.brand = brand
        l.target = match?.str("id") ?? ""; l.how = match?.str("how") ?? ""
        let kind = new.str("kind"); l.kind = kind == "staple" ? "measured" : kind
        l.place = new.str("place"); l.unit = new.str("unit"); l.size = new.str("size", p.str("size"))
        l.amount = p.str("amount"); l.each = l.amount
        l.expires = p.str("expires"); l.expiresBy = p.str("expires_by")
        l.on = !p.bool("skip"); l.skip = p.bool("skip")
        return l
    }

    /// A line kept to fix: what was sent, with the site's error.
    public static func fromSent(_ o: JSON) -> Line {
        var l = Line()
        let gauged = o.str("kind") == "gauged"
        l.key = o.str("key", l.key); l.store = o.str("store"); l.printed = o.str("printed"); l.barcode = o.str("barcode")
        l.name = o.str("name"); l.brand = o.str("brand"); l.target = o.str("item"); l.kind = o.str("kind")
        l.place = o.str("place"); l.unit = o.str("unit"); l.size = o.str("size")
        l.staple = o.bool("staple"); l.low = gauged ? "" : o.str("low")
        l.lowLevel = gauged ? o.int("low") : nil
        l.amount = o.str("amount"); l.each = l.amount; l.expires = o.str("expires"); l.expiresBy = o.str("expires_by")
        l.level = o.int("level"); l.error = o.str("error")
        return l
    }
}

/// One more of the same thing: "10 lb" and "10 lb" make "20 lb"; "2" and "1" make "3". Otherwise as it was.
public func bump(_ amount: String, _ each: String) -> String {
    func split(_ s: String) -> (Double, String)? {
        let t = s.trimmingCharacters(in: .whitespaces)
        var digits = ""
        var rest = Substring(t)
        while let c = rest.first, c.isASCII, c.isNumber || c == "." { digits.append(c); rest = rest.dropFirst() }
        guard !digits.isEmpty, digits.first != ".", digits.filter({ $0 == "." }).count <= 1, digits.last != ".",
              let n = Double(digits) else { return nil }
        return (n, rest.trimmingCharacters(in: .whitespaces))
    }
    guard let a = split(amount), let b = split(each), a.1.lowercased() == b.1.lowercased() else { return amount }
    let n = a.0 + b.0
    var s: String
    if n == n.rounded() { s = String(Int64(n)) } else {
        s = String(format: "%.3f", n)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
    }
    return (s + " " + a.1).trimmingCharacters(in: .whitespaces)
}

private let MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/// A calendar day, as the site writes them (YYYY-MM-DD).
public struct Day: Equatable, Comparable {
    public let year: Int, month: Int, day: Int
    public init(year: Int, month: Int, day: Int) { self.year = year; self.month = month; self.day = day }

    public init?(_ s: String) {
        let p = s.split(separator: "-")
        guard p.count == 3, p[0].count == 4, p[1].count == 2, p[2].count == 2,
              let y = Int(p[0]), let m = Int(p[1]), let d = Int(p[2]), (1...12).contains(m), (1...31).contains(d) else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public init(_ date: Date, calendar: Calendar = .current) {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        self.init(year: c.year!, month: c.month!, day: c.day!)
    }

    public static var today: Day { Day(Date()) }
    public var text: String { String(format: "%04d-%02d-%02d", year, month, day) }

    public func date(calendar: Calendar = .current) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12)) ?? Date()
    }

    public func plus(days: Int) -> Day {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let d = cal.date(from: DateComponents(year: year, month: month, day: day))!
        return Day(cal.date(byAdding: .day, value: days, to: d)!, calendar: cal)
    }

    public static func < (a: Day, b: Day) -> Bool { (a.year, a.month, a.day) < (b.year, b.month, b.day) }
}

/// 2026-12-09 → "Dec 9" (with the year when it isn't this one).
public func nice(_ day: String, today: Day = .today) -> String {
    guard let d = Day(day) else { return day }
    return "\(MONTHS[d.month - 1]) \(d.day)" + (d.year != today.year ? ", \(d.year)" : "")
}

/// How full a gauged thing is, by level.
public let LEVELS = ["Empty", "Almost out", "¼ left", "½ left", "¾ left", "Full"]

/// Whether an estimated date is close enough that the real one is worth checking (milk, meat, bread).
public func dateMatters(_ l: Line, today: Day = .today) -> Bool {
    guard l.expiresBy == "estimated", let d = Day(l.expires) else { return false }
    return d < today.plus(days: 31)
}

/// A barcode as the Android app (ML Kit) reads it, so the site remembers one product under one code:
/// iOS reads a UPC-A as an EAN-13 with a 0 in front ("0012345678905"); ML Kit gives the 12 digits.
public func sameBarcode(_ raw: String) -> String {
    let code = raw.trimmingCharacters(in: .whitespaces)
    if code.count == 13, code.hasPrefix("0"), code.allSatisfy({ $0.isASCII && $0.isNumber }) { return String(code.dropFirst()) }
    return code
}

/// Whether the scanner takes it as a barcode: 6 to 14 digits.
public func isBarcode(_ code: String) -> Bool {
    (6...14).contains(code.count) && code.allSatisfy { $0.isASCII && $0.isNumber }
}
