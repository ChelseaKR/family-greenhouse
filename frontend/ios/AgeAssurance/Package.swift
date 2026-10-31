// swift-tools-version: 5.10
// AgeAssurance: the app-store age-signal duty shared by Chelsea's three
// native iPhone apps and wrapped by the Capacitor app's plugin. Background: _agent-tools/growth/age-assurance-compliance-2026-10-30.md.
//
// Vendored, not fetched. Each app repo carries an identical copy of this
// directory so no new repository, deploy key or registry is needed. The
// canonical copy is ca-fish-planting-alerts/ios/AgeAssurance; when it
// changes, copy the whole directory into the other repos and bump
// `AgeAssurance.version` so a drifted copy is easy to spot.
//
// iOS 15 floor so the Capacitor app (deployment target 15.0) can link it.
// Foundation only on macOS, so `swift test` runs without a simulator. The
// Apple-framework adapter (DeclaredAgeRange, PermissionKit) compiles only
// where those frameworks and UIKit exist, behind availability checks, so
// apps with an iOS 17 deployment target link it safely.
//
// Product type: automatic (static). Link it into the app target only, never
// into a hosted unit-test bundle as well: a static library linked into both
// the app and its hosted tests fails at link time with duplicated code.
import PackageDescription

let package = Package(
    name: "AgeAssurance",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "AgeAssurance", targets: ["AgeAssurance"]),
    ],
    targets: [
        .target(
            name: "AgeAssurance",
            path: "Sources/AgeAssurance"
        ),
        .testTarget(
            name: "AgeAssuranceTests",
            dependencies: ["AgeAssurance"],
            path: "Tests/AgeAssuranceTests"
        ),
    ]
)
