// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SunnyWidgetCore",
    platforms: [.macOS(.v14), .iOS("17.2")],
    products: [
        .library(name: "SunnyWidgetCore", targets: ["SunnyWidgetCore"])
    ],
    targets: [
        .target(
            name: "SunnyWidgetCore",
            path: "core",
            exclude: ["SunnyWidgetCore.podspec"]
        ),
        .testTarget(
            name: "SunnyWidgetCoreTests",
            dependencies: ["SunnyWidgetCore"],
            path: "coreTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
