import SwiftUI

/// The site's console look: gold on green-black, in a monospace face (as the Android scanner's Look.kt).
enum Look {
    static let bg = Color(hex: 0x0B110D)
    static let panel = Color(hex: 0x121A15)
    static let gold = Color(hex: 0xE0B25A)
    static let ink = Color(hex: 0xE8E4D8)
    static let muted = Color(hex: 0x9AA393)
    static let faint = Color(hex: 0x6A7266)
    static let bad = Color(hex: 0xE06C5A)
    static let rule = Color(hex: 0x2A3A2F)
    static func mono(_ size: CGFloat, bold: Bool = false) -> Font { .system(size: size, weight: bold ? .bold : .regular, design: .monospaced) }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

struct Kicker: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased().map(String.init).joined(separator: " ")).font(Look.mono(12, bold: true)).foregroundColor(Look.gold)
    }
}

struct H1: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(Look.mono(22, bold: true)).foregroundColor(Look.ink) }
}

struct Hint: View {
    let text: String, color: Color
    init(_ text: String, color: Color = Look.muted) { self.text = text; self.color = color }
    var body: some View {
        Text(text).font(Look.mono(13)).foregroundColor(color).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The site's [ BUTTON ]: gold, or quiet (outlined).
struct Btn: View {
    let text: String
    var quiet = false
    var enabled = true
    var wide = false
    let action: () -> Void

    init(_ text: String, quiet: Bool = false, enabled: Bool = true, wide: Bool = false, action: @escaping () -> Void) {
        self.text = text; self.quiet = quiet; self.enabled = enabled; self.wide = wide; self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text("[ \(text.uppercased()) ]").font(Look.mono(13, bold: true)).tracking(1)
                .foregroundColor(!enabled ? Look.faint : quiet ? Look.gold : Look.bg)
                .lineLimit(1).minimumScaleFactor(0.7)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .frame(maxWidth: wide ? .infinity : nil)
                .background(quiet ? Color.clear : enabled ? Look.gold : Look.rule)
                .overlay(Rectangle().stroke(quiet ? Look.rule : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

/// A labelled text box, in the site's look.
struct Field: View {
    let label: String
    @Binding var value: String
    var placeholder = ""
    var keyboard: UIKeyboardType = .default
    var caps: TextInputAutocapitalization = .sentences

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(Look.mono(12)).foregroundColor(Look.muted)
            TextField("", text: $value, prompt: Text(placeholder).foregroundColor(Look.faint))
                .font(Look.mono(15)).foregroundColor(Look.ink).tint(Look.gold)
                .keyboardType(keyboard).textInputAutocapitalization(caps).autocorrectionDisabled()
                .padding(10).overlay(Rectangle().stroke(Look.rule, lineWidth: 1))
        }
    }
}

/// One of a row of choices (kind, how full): gold when picked.
struct Chip: View {
    let text: String, on: Bool, action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(text).font(Look.mono(12)).foregroundColor(on ? Look.bg : Look.muted)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(on ? Look.gold : Look.bg)
                .overlay(Rectangle().stroke(on ? Look.gold : Look.rule, lineWidth: 1))
        }.buttonStyle(.plain)
    }
}
