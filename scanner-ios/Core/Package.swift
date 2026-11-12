// swift-tools-version:5.9
// The scanner's logic, without the screens: the site's API, the lines being
// checked, and what waits for a connection. The app (scanner-ios/App) uses it;
// `swift test --package-path scanner-ios/Core` runs its tests.
import PackageDescription

let package = Package(
    name: "PantryCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "PantryCore", targets: ["PantryCore"])],
    targets: [
        .target(name: "PantryCore"),
        .testTarget(name: "PantryCoreTests", dependencies: ["PantryCore"]),
    ]
)
