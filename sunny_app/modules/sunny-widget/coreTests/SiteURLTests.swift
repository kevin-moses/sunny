import Foundation
import XCTest

@testable import SunnyWidgetCore

final class SiteURLTests: XCTestCase {
    func testAcceptsHTTPS() {
        XCTAssertEqual(SiteURL.parse("https://example.convex.site")?.host, "example.convex.site")
        XCTAssertNotNil(SiteURL.parse("HTTPS://Example.convex.site"))
    }

    func testAcceptsPlainHTTPOnlyForThisDevice() {
        for local in ["http://localhost:3211", "http://127.0.0.1:3211", "http://[::1]:3211", "http://dev.localhost"] {
            XCTAssertNotNil(SiteURL.parse(local), local)
        }
    }

    func testRefusesAnythingThatWouldSendTheTokenInClearOrNowhere() {
        for unsafe in [
            "http://example.convex.site",
            "http://127.example.com",
            "http://10.0.0.5:3211",
            "ftp://example.convex.site",
            "example.convex.site",
            "https://",
            "not a url",
        ] {
            XCTAssertNil(SiteURL.parse(unsafe), unsafe)
        }
    }
}
