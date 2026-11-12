import Foundation
import Network
import SwiftUI
import UIKit
import PantryCore

enum Screen { case home, pair, pairCamera, receipt, barcodes }

/// Everything the app is doing: the pairing, what's in the pantry (to add to),
/// and the basket of lines being checked before they're sent. The same as the
/// Android scanner's (scanner/.../Scanner.kt).
@MainActor
final class Scanner: ObservableObject {
    private let pairing: Pairing
    @Published var screen: Screen
    @Published var who: String
    @Published var items: [Item] = []
    @Published var lines: [Line] = []
    @Published var busy: String?
    @Published var said: String?
    @Published var error: String?
    @Published var waiting = 0
    @Published var lastScanned: String?
    private let monitor = NWPathMonitor()
    private var sending = false

    init(pairing: Pairing = Pairing()) {
        self.pairing = pairing
        screen = pairing.paired ? .home : .pair
        who = pairing.who
        waiting = pairing.outbox.queue().count
        // Additions made with no connection go as soon as there's one again (while the app is open).
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.sendWaiting() }
        }
        monitor.start(queue: DispatchQueue(label: "pantry.network"))
    }

    var site: String? { pairing.site }
    func host() -> String { (pairing.site ?? "").replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "") }
    private func day() -> String { Day.today.text }

    private func work(_ doing: String?, _ block: @escaping () async throws -> Void) {
        Task {
            self.busy = doing; self.error = nil
            defer { self.busy = nil }
            do { try await block() }
            catch is Unpaired {
                self.pairing.unpair(); self.who = ""; self.screen = .pair
                self.error = "This phone was unpaired from your pantry. Pair it again from the Pantry page."
            } catch {
                self.error = isOffline(error) ? "No connection to \(self.host())." : capital(error.localizedDescription)
            }
        }
    }

    // ── pairing ──────────────────────────────────────────────────────────

    func pair(site: String, code: String) {
        work("Pairing…") {
            guard let clean = Site.cleanSite(site) else { throw SiteError(message: "That isn't a site address, like sintfoap.xyz.", status: 0) }
            let out = try await Site.pair(origin: clean, code: code, name: UIDevice.current.model, version: appVersion)
            guard let key = out["key"] as? String else { throw SiteError(message: "The site didn't send a key.", status: 0) }
            let name = out.str("display_name", out.str("username"))
            self.pairing.pair(site: out.str("site").isEmpty ? clean : out.str("site"), key: key, who: name)
            self.who = self.pairing.who
            self.screen = .home
            self.said = "Paired with \(self.who)'s pantry."
            self.refresh()
        }
    }

    /// A pairing link (the QR code, or the phone's Camera app opening the app with it). → whether it was one.
    @discardableResult
    func pairLink(_ text: String) -> Bool {
        guard let link = Site.readPairLink(text) else { return false }
        pair(site: link.site, code: link.code)
        return true
    }

    func unpair() { pairing.unpair(); who = ""; lines.removeAll(); screen = .pair }

    // ── the pantry and the basket ────────────────────────────────────────

    func refresh() {
        work(nil) {
            guard self.pairing.paired else { return }
            self.items = itemsFrom(try await self.pairing.api().items(day: self.day()))
            self.takeBackToFix()
            self.sendWaiting()
        }
    }

    /// Anything sent later that the site wouldn't take comes back to fix.
    private func takeBackToFix() {
        let fix = pairing.outbox.toFix()
        guard !fix.isEmpty else { return }
        let have = Set(lines.map(\.key))
        lines += fix.map(Line.fromSent).filter { !have.contains($0.key) }
        pairing.outbox.clearToFix()
    }

    func sendWaiting() {
        waiting = pairing.outbox.queue().count
        guard waiting > 0, !sending, let api = try? pairing.api() else { return }
        sending = true
        Task {
            defer { self.sending = false }
            do { try await self.pairing.outbox.send(with: api) }
            catch is Unpaired { self.pairing.unpair(); self.who = ""; self.screen = .pair }
            catch {}
            self.waiting = self.pairing.outbox.queue().count
            self.takeBackToFix()
        }
    }

    func change(_ key: String, _ f: (inout Line) -> Void) {
        guard let i = lines.firstIndex(where: { $0.key == key }) else { return }
        f(&lines[i])
        lines[i].error = ""
    }
    func remove(_ key: String) { lines.removeAll { $0.key == key } }
    func clear() { lines.removeAll(); said = nil; error = nil }

    func readReceipt(_ photos: [UIImage]) {
        work("Reading the receipt…") {
            let images = photos.compactMap { shrunk($0) }
            let out = try await self.pairing.api().receipt(images: images, day: self.day())
            let shop = out.str("store")
            let read = out.list("lines").map { Line.from($0, store: shop) }
            self.lines += read
            self.screen = .home
            let by = out.str("by") == "claude" ? "Claude" : "the site's AI"
            self.said = "Read \(read.count) lines from the \(shop) receipt (by \(by)).".replacingOccurrences(of: "  ", with: " ")
                + (read.contains { $0.isNew && !$0.skip } ? " New ones are marked; scan a barcode or check the name." : "")
        }
    }

    /// A barcode the camera read: looked up, then added to the basket (or one more of it).
    func scanned(_ raw: String) {
        let code = sameBarcode(raw)
        guard isBarcode(code) else { return }
        if let i = lines.lastIndex(where: { $0.barcode == code }) {
            lines[i].amount = bump(lines[i].amount, lines[i].each.isEmpty ? "1" : lines[i].each)
            lastScanned = "One more \(lines[i].title): \(lines[i].amount)"
            return
        }
        work("Looking it up…") {
            let out = try await self.pairing.api().barcode(code, day: self.day())
            var l: Line
            if let product = out.obj("product"), let line = out.obj("line") {
                l = Line.from(line, barcode: code, brand: product.str("brand"))
                l.size = product.str("size").isEmpty ? (line.obj("new")?.str("size") ?? "") : product.str("size")
            } else {
                l = Line(); l.barcode = code; l.amount = "1"; l.each = "1"   // nobody knows it: you name it, once
            }
            self.lines.append(l)
            self.lastScanned = out.obj("product") == nil ? "New barcode: name it in the list" : l.title + (l.amount.isEmpty ? "" : ": \(l.amount)")
        }
    }

    func setDate(_ key: String, _ date: Date?, by: String) {
        change(key) { l in
            l.expires = date.map { Day($0).text } ?? ""
            l.expiresBy = date == nil ? "" : by
        }
    }

    /// Sends the ticked lines; what the site won't take stays with its reason. No connection: they wait on the phone.
    func send() {
        work("Adding to your pantry…") {
            let ticked = self.lines.filter(\.on)
            guard !ticked.isEmpty else { return }
            if let unnamed = ticked.first(where: { $0.isNew && $0.name.trimmingCharacters(in: .whitespaces).isEmpty }) {
                throw SiteError(message: "Give the new barcode a name first (\(unnamed.barcode)).", status: 0)
            }
            var added: [String] = [], tickedOff: [String] = [], queued = 0
            var stores: [String] = []
            for l in ticked where !stores.contains(l.store) { stores.append(l.store) }
            for shop in stores {
                let group = ticked.filter { $0.store == shop }
                let batch = group.map { $0.toJSON() }
                do {
                    let api = try self.pairing.api()
                    let out = try await api.add(store: shop, lines: batch)
                    let why = Dictionary(out.list("failed").map { ($0.str("key"), $0.str("error")) }, uniquingKeysWith: { a, _ in a })
                    added += out.list("added").map { $0.str("name") }
                    tickedOff += out.list("ticked").map { $0.str("title") }
                    for l in group {
                        if let e = why[l.key] {
                            if let i = self.lines.firstIndex(where: { $0.key == l.key }) { self.lines[i].error = e }
                        } else { self.remove(l.key) }
                    }
                } catch {
                    guard isOffline(error) else { throw error }
                    self.pairing.outbox.enqueue(store: shop, lines: batch)
                    group.forEach { self.remove($0.key) }
                    queued += group.count
                }
            }
            self.waiting = self.pairing.outbox.queue().count
            if !added.isEmpty { self.items = itemsFrom(try await self.pairing.api().items(day: self.day())) }
            let fixes = self.lines.filter { !$0.error.isEmpty }.count
            self.said = [
                added.isEmpty ? nil : "Added \(added.count): \(added.joined(separator: ", ")).",
                tickedOff.isEmpty ? nil : "Ticked off your shopping list: \(tickedOff.joined(separator: ", ")).",
                queued > 0 ? "No connection, so \(queued) will go when there is one." : nil,
                fixes > 0 ? "\(fixes) still need\(fixes == 1 ? "s" : "") a fix." : nil,
            ].compactMap { $0 }.joined(separator: " ")
        }
    }
}

func capital(_ s: String) -> String { s.isEmpty ? "Something went wrong." : s.prefix(1).uppercased() + s.dropFirst() }

/// A photo, the right way up, at most 1568 px across (more than the site's readers use), as base64 JPEG.
func shrunk(_ image: UIImage, side: CGFloat = 1568) -> String? {
    let longest = max(image.size.width, image.size.height)
    let scale = min(1, side / max(longest, 1))
    let size = CGSize(width: (image.size.width * scale).rounded(), height: (image.size.height * scale).rounded())
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    // Drawing it applies its orientation, so what's sent is the right way up.
    let drawn = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    return drawn.jpegData(compressionQuality: 0.85)?.base64EncodedString()
}
