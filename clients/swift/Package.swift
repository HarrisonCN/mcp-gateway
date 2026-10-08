// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "MCPGateway",
    platforms: [.macOS(.v12), .iOS(.v15), .tvOS(.v15), .watchOS(.v8)],
    products: [.library(name: "MCPGateway", targets: ["MCPGateway"])],
    targets: [
        .target(name: "MCPGateway"),
        .testTarget(name: "MCPGatewayTests", dependencies: ["MCPGateway"]),
    ]
)
