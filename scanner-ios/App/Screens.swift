import SwiftUI
import UIKit
import PantryCore

/// The screens, as the Android scanner's (scanner/.../Screens.kt).
struct AppView: View {
    @ObservedObject var s: Scanner

    var body: some View {
        ZStack(alignment: .bottom) {
            Look.bg.ignoresSafeArea()
            switch s.screen {
            case .pair: PairScreen(s: s)
            case .pairCamera: PairCamera(s: s)
            case .home: HomeScreen(s: s)
            case .receipt: ReceiptScreen(s: s)
            case .barcodes: BarcodeScreen(s: s)
            }
            if let doing = s.busy {
                HStack(spacing: 12) {
                    ProgressView().tint(Look.gold)
                    Text(doing).font(Look.mono(14)).foregroundColor(Look.ink)
                    Spacer()
                }
                .padding(14).background(Look.panel).overlay(Rectangle().stroke(Look.gold, lineWidth: 1))
            }
        }
        .preferredColorScheme(.dark)
        .onOpenURL { url in _ = s.pairLink(url.absoluteString) }
    }
}

private struct Said: View {
    @ObservedObject var s: Scanner
    var body: some View {
        if let e = s.error { Hint(e, color: Look.bad) }
        if let m = s.said { Hint(m, color: Look.gold) }
    }
}

// ── pairing ──────────────────────────────────────────────────────────────

struct PairScreen: View {
    @ObservedObject var s: Scanner
    @State private var site = ""
    @State private var code = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Kicker("Kitchen"); H1("Pantry scanner")
                Hint("Snap receipts and scan barcodes as you unpack the groceries. Everything goes into your Pantry on the site.")
                Hint("To start, on a computer open Pantry and press Phone scanner. Then scan the code it shows (the iPhone's Camera app can too).", color: Look.ink)
                Btn("Scan the code", wide: true) { s.error = nil; s.screen = .pairCamera }
                Spacer().frame(height: 8)
                Hint("Or type it:")
                Field(label: "Site", value: $site, placeholder: "sintfoap.xyz", keyboard: .URL, caps: .never)
                Field(label: "Code", value: $code, placeholder: "ABCD-EFGH", caps: .characters)
                Btn("Pair", quiet: true, enabled: !code.trimmingCharacters(in: .whitespaces).isEmpty && s.busy == nil) { s.pair(site: site, code: code) }
                Said(s: s)
            }.padding(20)
        }
        .onAppear {
            if site.isEmpty { site = (s.site ?? defaultSite).replacingOccurrences(of: "https://", with: "") }
        }
    }
}

struct PairCamera: View {
    @ObservedObject var s: Scanner
    @State private var seen = false

    var body: some View {
        VStack(spacing: 0) {
            CameraView(use: .qr) { codes in
                guard !seen, let link = codes.first(where: { Site.readPairLink($0) != nil }) else { return }
                seen = true
                s.pairLink(link)
            }
            VStack(alignment: .leading, spacing: 8) {
                Hint("Point the camera at the code on your Pantry page.", color: Look.ink)
                Btn("Back", quiet: true) { s.screen = .pair }
            }.padding(16).background(Look.panel)
        }
    }
}

// ── the basket ───────────────────────────────────────────────────────────

struct HomeScreen: View {
    @ObservedObject var s: Scanner
    @Environment(\.scenePhase) private var phase

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Kicker("Pantry scanner")
                        H1(s.who.isEmpty ? "Your pantry" : "\(s.who)'s pantry")
                    }
                    Spacer()
                    Menu {
                        Text("Paired with \(s.host())")
                        Button("Unpair this phone", role: .destructive) { s.unpair() }
                    } label: {
                        Text("⋯").font(Look.mono(22, bold: true)).foregroundColor(Look.gold).padding(8)
                    }
                }
                if s.waiting > 0 {
                    Hint("\(s.waiting) batch\(s.waiting == 1 ? "" : "es") waiting for a connection; they'll go once there's one.", color: Look.gold)
                }
                HStack(spacing: 10) {
                    Btn("Snap receipt", wide: true) { s.said = nil; s.error = nil; s.screen = .receipt }
                    Btn("Scan barcodes", wide: true) { s.said = nil; s.error = nil; s.lastScanned = nil; s.screen = .barcodes }
                }
                Said(s: s)
            }.padding([.horizontal, .top], 16).padding(.bottom, 6)

            if s.lines.isEmpty {
                ScrollView {
                    Hint("Start with the receipt: it does most of the work. Then scan the barcode of anything it couldn't make out, or anything bought without one. " +
                         "Expiry dates are estimated; set the real one on anything where it matters.").padding(16)
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(s.lines) { l in LineCard(s: s, l: l) }
                        Spacer().frame(height: 90)
                    }.padding(.horizontal, 16).padding(.top, 6)
                }
                .scrollDismissesKeyboard(.interactively)
                let n = s.lines.filter(\.on).count
                HStack(spacing: 10) {
                    Btn(n == 0 ? "Add to pantry" : "Add \(n) to pantry", enabled: n > 0 && s.busy == nil, wide: true) { s.send() }
                    Btn("Clear", quiet: true) { s.clear() }
                }.padding(12).background(Look.panel)
            }
        }
        .onAppear { s.refresh() }
        .onChange(of: phase) { p in if p == .active { s.refresh() } }
    }
}

private let HOW = ["remembered": "remembered from this store", "name": "matched by name", "barcode": "known barcode"]

struct LineCard: View {
    @ObservedObject var s: Scanner
    let l: Line
    @State private var picking = false

    private func bind(_ path: WritableKeyPath<Line, String>) -> Binding<String> {
        Binding(get: { l[keyPath: path] }, set: { v in s.change(l.key) { $0[keyPath: path] = v } })
    }

    var body: some View {
        let item = s.items.first { $0.id == l.target }
        let kind = item?.kind ?? l.kind
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                Button { s.change(l.key) { $0.on.toggle() } } label: {
                    Text(l.on ? "[x]" : "[ ]").font(Look.mono(15, bold: true)).foregroundColor(l.on ? Look.gold : Look.faint)
                }.buttonStyle(.plain)
                VStack(alignment: .leading, spacing: 2) {
                    if !l.printed.isEmpty { Text(l.printed).font(Look.mono(12)).foregroundColor(Look.faint) }
                    if !l.barcode.isEmpty && l.printed.isEmpty { Text("barcode \(l.barcode)").font(Look.mono(12)).foregroundColor(Look.faint) }
                    Text(l.title).font(Look.mono(15, bold: true)).foregroundColor(l.on ? Look.ink : Look.faint)
                }
                Spacer()
                Button { s.remove(l.key) } label: { Text("×").font(.system(size: 22)).foregroundColor(Look.faint) }.buttonStyle(.plain)
            }
            if l.skip && !l.on {
                Hint("Not food, so it's left off. Tick it to add it anyway.", color: Look.faint)
            } else if l.on {
                details(item: item, kind: kind)
            }
        }
        .padding(12)
        .overlay(Rectangle().stroke(l.error.isEmpty ? Look.rule : Look.bad, lineWidth: 1))
    }

    @ViewBuilder
    private func details(item: Item?, kind: String) -> some View {
        // What it adds to.
        Menu {
            Button("New: \(l.name.isEmpty ? "something new" : l.name)") { s.change(l.key) { $0.target = "" } }
            ForEach(s.items) { i in
                Button("\(i.name) (have \(i.text))") { s.change(l.key) { $0.target = i.id } }
            }
        } label: {
            Text(item.map { "→ \($0.name) (have \($0.text))" } ?? "→ New: \(l.name.isEmpty ? "name it below" : l.name)")
                .font(Look.mono(14)).foregroundColor(item != nil ? Look.ink : Look.gold).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                .overlay(Rectangle().stroke(Look.rule, lineWidth: 1))
        }
        Hint(item != nil ? (l.how.isEmpty ? "picked" : HOW[l.how] ?? "picked") : "new to your pantry", color: Look.faint)

        if item == nil {
            Field(label: "Name", value: bind(\.name), placeholder: "Oat milk")
            HStack(spacing: 6) {
                ForEach([("", "Guess"), ("measured", "Measured"), ("counted", "Counted"), ("gauged", "Gauged")], id: \.0) { choice in
                    Chip(text: choice.1, on: l.kind == choice.0) { s.change(l.key) { $0.kind = choice.0 } }
                }
            }
            HStack(spacing: 8) {
                Field(label: "Kept in", value: bind(\.place), placeholder: "Cupboard")
                if l.kind == "counted" { Field(label: "One is a", value: bind(\.unit), placeholder: "can", caps: .never) }
            }
            // A staple: kept stocked, and running low at an amount, a count, or a mark on the gauge.
            Button { s.change(l.key) { $0.staple.toggle() } } label: {
                HStack(spacing: 8) {
                    Text(l.staple ? "[x]" : "[ ]").font(Look.mono(14, bold: true)).foregroundColor(l.staple ? Look.gold : Look.faint)
                    Text("Staple: keep it stocked").font(Look.mono(13)).foregroundColor(Look.muted)
                }
            }.buttonStyle(.plain)
            if l.staple && l.kind == "gauged" {
                Hint("Running low at")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach((0...4).reversed(), id: \.self) { n in
                            Chip(text: LEVELS[n], on: (l.lowLevel ?? 1) == n) { s.change(l.key) { $0.lowLevel = n } }
                        }
                    }
                }
            } else if l.staple {
                Field(label: "Running low at", value: bind(\.low),
                      placeholder: l.kind == "counted" ? "2" : l.kind == "measured" ? "2 lb" : "2 lb, 2, or ¼ left", caps: .never)
            }
        }

        if kind == "gauged" {
            Hint("How full is it?")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach((1...5).reversed(), id: \.self) { n in
                        Chip(text: LEVELS[n], on: (l.level ?? 5) == n) { s.change(l.key) { $0.level = n } }
                    }
                }
            }
        } else {
            HStack(alignment: .top, spacing: 8) {
                Field(label: "How much", value: Binding(get: { l.amount }, set: { v in s.change(l.key) { $0.amount = v; $0.each = v } }),
                      placeholder: kind == "measured" ? "10 lb" : "2", caps: .never)
                VStack(alignment: .leading, spacing: 4) {
                    Text(l.expires.isEmpty ? "No expiry date" : "Expires \(nice(l.expires))" + (l.expiresBy == "estimated" ? " (est.)" : ""))
                        .font(Look.mono(13)).foregroundColor(Look.ink)
                    Button { picking = true } label: {
                        Text(dateMatters(l) ? "[ CHECK THE DATE ]" : l.expires.isEmpty ? "set a date" : "change it")
                            .font(Look.mono(12, bold: dateMatters(l))).foregroundColor(Look.gold)
                    }.buttonStyle(.plain)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 20)
            }
            .sheet(isPresented: $picking) { DateSheet(s: s, l: l) }
        }
        if !l.error.isEmpty { Hint(capital(l.error), color: Look.bad) }
    }
}

/// The real expiry date, picked off a calendar.
private struct DateSheet: View {
    @ObservedObject var s: Scanner
    let l: Line
    @State private var date = Date()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Kicker("Expires"); H1(l.title)
            DatePicker("Expires", selection: $date, displayedComponents: .date)
                .datePickerStyle(.graphical).tint(Look.gold).colorScheme(.dark)
            HStack(spacing: 10) {
                Btn("Set it", wide: true) { s.setDate(l.key, date, by: "typed"); dismiss() }
                Btn("No date", quiet: true) { s.setDate(l.key, nil, by: ""); dismiss() }
            }
            Spacer()
        }
        .padding(20)
        .background(Look.bg.ignoresSafeArea())
        .presentationDetents([.large])
        .onAppear { date = Day(l.expires)?.date() ?? Date() }
    }
}

// ── the cameras ──────────────────────────────────────────────────────────

struct ReceiptScreen: View {
    @ObservedObject var s: Scanner
    @State private var shots: [UIImage] = []
    @State private var problem: String?
    @State private var taker = PhotoTaker()

    var body: some View {
        VStack(spacing: 0) {
            CameraView(use: .photo, taker: taker)
            VStack(alignment: .leading, spacing: 8) {
                Hint(shots.isEmpty
                     ? "Lay the receipt flat in good light, all of it in the picture. A long one: take it in parts, top to bottom (up to 4)."
                     : "\(shots.count) picture\(shots.count == 1 ? "" : "s"). Take the next part, or read it.", color: Look.ink)
                if let p = problem { Hint(p, color: Look.bad) }
                if let e = s.error { Hint(e, color: Look.bad) }
                HStack(spacing: 10) {
                    Btn(shots.isEmpty ? "Snap" : "Snap more", quiet: !shots.isEmpty, enabled: shots.count < 4 && s.busy == nil, wide: true) {
                        problem = nil
                        taker.take { image, e in
                            if let image { shots.append(image); UIImpactFeedbackGenerator(style: .medium).impactOccurred() } else { problem = e }
                        }
                    }
                    if !shots.isEmpty { Btn("Read it", enabled: s.busy == nil, wide: true) { s.readReceipt(shots) } }
                }
                Btn("Back", quiet: true) { shots.removeAll(); s.screen = .home }
            }.padding(14).background(Look.panel)
        }
    }
}

struct BarcodeScreen: View {
    @ObservedObject var s: Scanner
    @State private var last = ("", Date.distantPast)

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                CameraView(use: .barcodes) { codes in
                    guard let code = codes.first else { return }
                    let now = Date()
                    // The same code stays in view: once, until it's been away (or 2.5 s pass, for one more of the same).
                    if code == last.0 && now.timeIntervalSince(last.1) < 2.5 { last = (code, now); return }
                    last = (code, now)
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    s.scanned(code)
                }
                Rectangle().fill(Look.gold).frame(height: 2).padding(.horizontal, 40).allowsHitTesting(false)
            }
            VStack(alignment: .leading, spacing: 8) {
                Hint(s.lastScanned ?? "Point it at a barcode. Each one goes in your list to check; scan the same thing again for one more.", color: Look.ink)
                if let e = s.error { Hint(e, color: Look.bad) }
                Hint("\(s.lines.filter { !$0.barcode.isEmpty }.count) scanned so far", color: Look.faint)
                Btn("Done", wide: true) { s.error = nil; s.screen = .home }
            }.padding(14).background(Look.panel)
        }
    }
}
