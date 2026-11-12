import SwiftUI

/// Pantry scanner for iPhone: the same app as the Android one in scanner/,
/// filling Pantry (src/pantry.js) while you unpack groceries.
@main
struct PantryScannerApp: App {
    @StateObject private var scanner = Scanner()

    var body: some Scene {
        WindowGroup { AppView(s: scanner) }
    }
}
