// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import Foundation
import Tauri
import UIKit
import WebKit

private struct PageInsets: Decodable {
    let top: Double
    let right: Double
    let bottom: Double
    let left: Double
}

private struct PageBounds: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let clip: PageInsets?

    var rect: CGRect {
        CGRect(x: x + (clip?.left ?? 0), y: y + (clip?.top ?? 0),
               width: max(1, width - (clip?.left ?? 0) - (clip?.right ?? 0)),
               height: max(1, height - (clip?.top ?? 0) - (clip?.bottom ?? 0)))
    }
    var viewport: CGRect {
        CGRect(x: -(clip?.left ?? 0), y: -(clip?.top ?? 0), width: width, height: height)
    }
}

private struct PageArgs: Decodable {
    let epoch: UInt64
    let label: String?
    let url: String?
    let bounds: PageBounds?
    let hidden: Bool?
    let visible: Bool?
    let action: String?
    let script: String?
}

private struct PageState: Encodable {
    let url: String
    let title: String
    let isLoading: Bool
    let canGoBack: Bool
    let canGoForward: Bool
    let faviconUrls: [String]
    let newTabUrls: [String]
    let error: String?
}

private func failure(_ description: String) -> NSError {
    NSError(domain: "ThunderboltPages", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
}

private func allowedUrl(_ value: String) -> URL? {
    guard value == "about:blank" || value.count <= 8192 else { return nil }
    guard let url = URL(string: value) else { return nil }
    if value == "about:blank" { return url }
    guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return nil }
    return url
}

/// Each page is an ordinary WKWebView. It never receives the host's Tauri scripts,
/// message handlers, data store, custom schemes, or filesystem permissions.
private final class Page: NSObject, WKNavigationDelegate, WKUIDelegate {
    let epoch: UInt64
    let container: UIView
    let view: WKWebView
    var currentUrl: String
    var error: String?
    private var newTabUrls: [String] = []

    init(epoch: UInt64, url: URL, dataStore: WKWebsiteDataStore) {
        self.epoch = epoch
        currentUrl = url.absoluteString
        container = UIView(frame: .zero)
        container.clipsToBounds = true
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        view.navigationDelegate = self
        view.uiDelegate = self
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.allowsBackForwardNavigationGestures = true
        container.addSubview(view)
    }

    func load(_ url: URL) {
        error = nil
        currentUrl = url.absoluteString
        view.load(URLRequest(url: url))
    }

    func state() -> PageState {
        let popups = newTabUrls
        newTabUrls.removeAll()
        return PageState(
            url: view.url?.absoluteString ?? currentUrl,
            title: view.title ?? "", isLoading: view.isLoading,
            canGoBack: view.canGoBack, canGoForward: view.canGoForward,
            faviconUrls: [], newTabUrls: popups, error: error
        )
    }

    func close() {
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
        container.removeFromSuperview()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Nested frames remain normal website content; only top-level destinations
        // determine the page's browser origin and may reach the navigation bar.
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
            return
        }
        let allowed = navigationAction.request.url.flatMap { allowedUrl($0.absoluteString) } != nil
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil,
           let value = navigationAction.request.url?.absoluteString,
           allowedUrl(value) != nil, value != "about:blank", newTabUrls.count < 8 {
            newTabUrls.append(value)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        error = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError failure: Error) {
        record(failure)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError failure: Error) {
        record(failure)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        error = "The page process stopped. Reload to continue."
    }

    private func record(_ failure: Error) {
        let native = failure as NSError
        if native.domain == NSURLErrorDomain && native.code == NSURLErrorCancelled { return }
        error = failure.localizedDescription
    }
}

class PagesPlugin: Plugin {
    private weak var host: WKWebView?
    private var pages: [String: Page] = [:]
    private var minimumEpoch: UInt64 = 0
    private let dataStore = WKWebsiteDataStore.nonPersistent()

    @objc public override func load(webview: WKWebView) {
        DispatchQueue.main.async {
            self.pages.values.forEach { $0.close() }
            self.pages.removeAll()
            self.host = webview
        }
    }

    private func run(_ invoke: Invoke, action: @escaping (PageArgs) throws -> Void) {
        do {
            let args = try invoke.parseArgs(PageArgs.self)
            DispatchQueue.main.async {
                do { try action(args) }
                catch { invoke.reject(error.localizedDescription) }
            }
        } catch { invoke.reject(error.localizedDescription) }
    }

    private func page(_ args: PageArgs) throws -> Page {
        guard let label = args.label, let page = pages[label], page.epoch == args.epoch else {
            throw failure("The page is closed or belongs to an earlier session")
        }
        return page
    }

    private func present(_ page: Page, bounds: PageBounds, visible: Bool) throws {
        guard let host, let parent = host.superview else { throw failure("The main webview is unavailable") }
        // CSS pixels map to UIKit points because the host uses a device-width viewport.
        page.container.frame = host.convert(bounds.rect, to: parent)
        page.view.frame = bounds.viewport
        if page.container.superview !== parent { parent.addSubview(page.container) }
        page.container.isHidden = !visible
    }

    @objc public func capabilities(_ invoke: Invoke) {
        invoke.resolve(["available": true, "nativeInput": false, "screenshot": false, "isolatedSession": true])
    }

    @objc public func create(_ invoke: Invoke) {
        run(invoke) { args in
            guard args.epoch >= self.minimumEpoch else { throw failure("The main page navigated") }
            guard let label = args.label, self.pages[label] == nil,
                  let rawUrl = args.url, let url = allowedUrl(rawUrl), let bounds = args.bounds else {
                throw failure("A new page label, HTTP(S) URL, and bounds are required")
            }
            let page = Page(epoch: args.epoch, url: url, dataStore: self.dataStore)
            try self.present(page, bounds: bounds, visible: !(args.hidden ?? false) && rawUrl != "about:blank")
            self.pages[label] = page
            page.load(url)
            invoke.resolve()
        }
    }

    @objc public func present(_ invoke: Invoke) {
        run(invoke) { args in
            guard let bounds = args.bounds, let visible = args.visible else { throw failure("Page bounds and visibility are required") }
            try self.present(self.page(args), bounds: bounds, visible: visible)
            invoke.resolve()
        }
    }

    @objc public func navigate(_ invoke: Invoke) {
        run(invoke) { args in
            guard let value = args.url, let url = allowedUrl(value) else { throw failure("An HTTP(S) page address is required") }
            try self.page(args).load(url)
            invoke.resolve()
        }
    }

    @objc public func action(_ invoke: Invoke) {
        run(invoke) { args in
            let page = try self.page(args)
            page.error = nil
            switch args.action {
            case "back": if page.view.canGoBack { page.view.goBack() }
            case "forward": if page.view.canGoForward { page.view.goForward() }
            case "reload": page.view.reload()
            case "stop": page.view.stopLoading()
            default: throw failure("Unsupported page navigation action")
            }
            invoke.resolve()
        }
    }

    @objc public func state(_ invoke: Invoke) {
        run(invoke) { args in invoke.resolve(try self.page(args).state()) }
    }

    @objc public func close(_ invoke: Invoke) {
        run(invoke) { args in
            guard let label = args.label else { throw failure("A page label is required") }
            if let page = self.pages[label], page.epoch == args.epoch {
                page.close()
                self.pages.removeValue(forKey: label)
            }
            invoke.resolve()
        }
    }

    /// Called only by Rust's fixed observation/picker methods, never exposed as a frontend command.
    @objc public func evaluate(_ invoke: Invoke) {
        run(invoke) { args in
            let page = try self.page(args)
            guard let script = args.script else { throw failure("No host observation supplied") }
            page.view.evaluateJavaScript(script) { result, error in
                if let error { invoke.reject(error.localizedDescription); return }
                guard let value = result as? String else { invoke.reject("Page returned no observation"); return }
                guard self.pages[args.label ?? ""] === page else { invoke.reject("Page closed during observation"); return }
                invoke.resolve(value)
            }
        }
    }

    /// Generation-scoped cleanup cannot remove pages created by the new document.
    @objc public func reset(_ invoke: Invoke) {
        run(invoke) { args in
            self.minimumEpoch = max(self.minimumEpoch, args.epoch)
            let stale = self.pages.filter { $0.value.epoch < args.epoch }.map(\.key)
            for label in stale { self.pages.removeValue(forKey: label)?.close() }
            invoke.resolve()
        }
    }
}

@_cdecl("init_plugin_pages")
func initPlugin() -> Plugin { PagesPlugin() }
