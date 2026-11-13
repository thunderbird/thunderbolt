/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import WebKit

/// Runs the shared static checker, then renders under the same offline CSP as
/// the visible artifact. The checker's state lives outside the page's JS world.
@MainActor
final class NativeArtifactVerifier: NSObject, WKNavigationDelegate {
    private var webView: WKWebView?
    private var pending: CheckedContinuation<String, Error>?
    private var failure: Error?

    static func verify(_ html: String) async throws -> ChatJSONValue {
        let verifier = NativeArtifactVerifier()
        return try await withTaskCancellationHandler {
            do {
                let errors = try await verifier.run(html)
                return .object(["ok": .bool(errors.isEmpty), "errors": .array(errors.map(ChatJSONValue.string))])
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                return .object(["ok": .bool(false), "errors": .array([.string("Verification could not run: " + error.localizedDescription)])])
            }
        } onCancel: {
            Task { @MainActor in verifier.fail(CancellationError()) }
        }
    }

    private func run(_ html: String) async throws -> [String] {
        try Task.checkCancellation()
        guard let scriptURL = Bundle.main.url(forResource: "artifact-check", withExtension: "js") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let script = try String(contentsOf: scriptURL, encoding: .utf8)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.addUserScript(WKUserScript(
            source: script + Self.errorObserver, injectionTime: .atDocumentStart,
            forMainFrameOnly: true, in: .defaultClient
        ))
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1024, height: 768), configuration: configuration)
        webView = view
        view.navigationDelegate = self
        let deadline = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(4))
                self?.fail(ArtifactError.timeout)
            } catch is CancellationError {}
            catch { self?.fail(error) }
        }
        defer {
            deadline.cancel()
            view.stopLoading()
            view.navigationDelegate = nil
            webView = nil
        }
        try await load("<!doctype html><html><head></head><body></body></html>")
        let staticJSON = try await evaluate("return JSON.stringify(await globalThis.__thunderboltStaticCheck(html))", arguments: ["html": html])
        let staticErrors = try JSONDecoder().decode([String].self, from: Data(staticJSON.utf8))
        guard staticErrors.isEmpty else { return staticErrors }
        try await load(SandboxedArtifactDocument.wrap(html))
        // Match Tauri's post-ready grace window for rejected promises and timers.
        try await Task.sleep(for: .milliseconds(250))
        let runtimeJSON = try await evaluate("""
        const errors = globalThis.__thunderboltArtifactErrors.slice();
        const detail = document.getElementById('tb-artifact-runtime-error')?.textContent;
        if (detail) errors.push(detail);
        return JSON.stringify(errors);
        """)
        return try JSONDecoder().decode([String].self, from: Data(runtimeJSON.utf8))
    }

    private func check() throws {
        try Task.checkCancellation()
        if let failure { throw failure }
    }

    private func load(_ html: String) async throws {
        try check()
        let _: String = try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            webView?.loadHTMLString(html, baseURL: SandboxedArtifactDocument.origin)
        }
    }

    private func evaluate(_ source: String, arguments: [String: String] = [:]) async throws -> String {
        try check()
        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            webView?.callAsyncJavaScript(source, arguments: arguments, in: nil, in: .defaultClient) { [weak self] result in
                switch result {
                case .success(let value):
                    guard let text = value as? String else { self?.fail(CloudError.invalidResponse); return }
                    self?.finish(.success(text))
                case .failure(let error): self?.fail(error)
                }
            }
        }
    }

    private func finish(_ result: Result<String, Error>) {
        let continuation = pending
        pending = nil
        continuation?.resume(with: result)
    }

    private func fail(_ error: Error) {
        failure = error
        finish(.failure(error))
        webView?.stopLoading()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success("")) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail(ArtifactError.processTerminated) }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if navigationAction.targetFrame?.isMainFrame == true,
           navigationAction.request.url == SandboxedArtifactDocument.origin { return .allow }
        guard navigationAction.targetFrame?.isMainFrame == true,
              let scheme = navigationAction.request.url?.scheme?.lowercased(),
              ["about", "data", "blob"].contains(scheme) else { return .cancel }
        return .allow
    }

    private enum ArtifactError: LocalizedError {
        case timeout, processTerminated
        var errorDescription: String? {
            switch self {
            case .timeout: "Timed out waiting for the artifact to load."
            case .processTerminated: "The artifact's web content process stopped."
            }
        }
    }

    private static let errorObserver = """
    ;(() => {
      const errors = [];
      globalThis.__thunderboltArtifactErrors = errors;
      addEventListener('error', event => {
        const target = event.target;
        errors.push(target && target !== window
          ? 'Resource failed to load: ' + (target.src || target.href || target.tagName)
          : String(event.message || 'Script failed'));
      }, true);
      addEventListener('unhandledrejection', event => {
        const reason = event.reason;
        errors.push(String(reason && reason.message ? reason.message : reason));
      });
    })();
    """
}
