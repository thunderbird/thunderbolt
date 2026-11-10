// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import XCTest
import Tauri
import UIKit
import WebKit
@testable import tauri_plugin_pages

@MainActor
final class PagesPluginTests: XCTestCase {
    private var window: UIWindow!
    private var host: WKWebView!
    private var plugin: PagesPlugin!

    override func setUp() async throws {
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIViewController()
        host = WKWebView(frame: window.bounds)
        window.rootViewController!.view.addSubview(host)
        window.makeKeyAndVisible()
        plugin = PagesPlugin()
        plugin.load(webview: host)
    }

    override func tearDown() async throws {
        _ = try await call("reset", ["epoch": 100])
        window.isHidden = true
        plugin = nil
        host = nil
        window = nil
    }

    private func call(_ command: String, _ args: [String: Any]) async throws -> Any {
        let json = String(data: try JSONSerialization.data(withJSONObject: args), encoding: .utf8)!
        return try await withCheckedThrowingContinuation { continuation in
            let invoke = Invoke(command: command, callback: 0, error: 1, sendResponse: { id, payload in
                if id == 1 {
                    continuation.resume(throwing: NSError(domain: "PageTest", code: 1, userInfo: [NSLocalizedDescriptionKey: payload ?? "Unknown error"]))
                } else {
                    do {
                        let value = try JSONSerialization.jsonObject(with: Data((payload ?? "null").utf8), options: [.fragmentsAllowed])
                        continuation.resume(returning: value)
                    } catch { continuation.resume(throwing: error) }
                }
            }, sendChannelData: { _, _ in }, data: json)
            switch command {
            case "create": plugin.create(invoke)
            case "present": plugin.present(invoke)
            case "state": plugin.state(invoke)
            case "evaluate": plugin.evaluate(invoke)
            case "close": plugin.close(invoke)
            case "reset": plugin.reset(invoke)
            default: XCTFail("Unknown test command"); continuation.resume(returning: NSNull())
            }
        }
    }

    private func create(_ label: String, epoch: Int = 1) async throws {
        _ = try await call("create", ["label": label, "epoch": epoch, "url": "about:blank", "hidden": true,
                                    "bounds": ["x": 20, "y": 100, "width": 320, "height": 500]])
    }

    private var guestViews: [WKWebView] {
        window.rootViewController!.view.subviews.filter { $0 !== host }.flatMap { $0.subviews.compactMap { $0 as? WKWebView } }
    }

    func testNativePagesAreIsolatedAndPlacementDoesNotReloadThem() async throws {
        try await create("page-one")
        let first = try XCTUnwrap(guestViews.first)
        XCTAssertFalse(first.configuration.websiteDataStore === host.configuration.websiteDataStore)
        XCTAssertFalse(first.configuration.websiteDataStore.isPersistent)
        first.loadHTMLString("<html><head><meta name='viewport' content='width=device-width, initial-scale=1'></head><body><input id='value' value='kept'></body></html>", baseURL: nil)
        for _ in 0..<100 {
            if (try? await first.evaluateJavaScript("Boolean(document.getElementById('value'))")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let observation = try await call("evaluate", ["label": "page-one", "epoch": 1,
            "script": "JSON.stringify({value:document.getElementById('value').value,native:typeof window.__TAURI_INTERNALS__})"])
        let value = try XCTUnwrap(observation as? String)
        XCTAssertTrue(value.contains("kept"))
        XCTAssertTrue(value.contains("undefined"))

        _ = try await call("present", ["label": "page-one", "epoch": 1, "visible": true,
            "bounds": ["x": 20, "y": 100, "width": 320, "height": 500,
                       "clip": ["top": 40, "right": 10, "bottom": 60, "left": 5]]])
        XCTAssertEqual(first.superview?.frame, CGRect(x: 25, y: 140, width: 305, height: 400))
        XCTAssertEqual(first.frame, CGRect(x: -5, y: -40, width: 320, height: 500))
        let preserved = try await first.evaluateJavaScript("document.getElementById('value').value") as? String
        XCTAssertEqual(preserved, "kept")

        try await create("page-two")
        XCTAssertEqual(guestViews.count, 2)
        XCTAssertTrue(guestViews[0].configuration.websiteDataStore === guestViews[1].configuration.websiteDataStore)
        _ = try await call("close", ["label": "page-one", "epoch": 1])
        XCTAssertEqual(guestViews.count, 1)
    }

    func testDelayedRefreshCleanupPreservesNewGenerationAndRejectsOldCalls() async throws {
        try await create("page-old")
        try await create("page-new", epoch: 2)
        _ = try await call("reset", ["epoch": 2])
        XCTAssertEqual(guestViews.count, 1)
        _ = try await call("state", ["label": "page-new", "epoch": 2])
        do {
            _ = try await call("state", ["label": "page-new", "epoch": 1])
            XCTFail("A stale host document must not operate a new page")
        } catch { XCTAssertTrue(error.localizedDescription.contains("earlier session")) }
        _ = try await call("reset", ["epoch": 2])
        XCTAssertEqual(guestViews.count, 1)
        do {
            try await create("page-late", epoch: 1)
            XCTFail("An old create queued before reload must not resurrect a native view")
        } catch { XCTAssertTrue(error.localizedDescription.contains("navigated")) }
    }
}
