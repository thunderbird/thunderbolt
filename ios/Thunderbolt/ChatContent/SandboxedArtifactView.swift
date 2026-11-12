/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI
import WebKit

/// Keeps the artifact's scripts and resources inside a dedicated web content process.
struct SandboxedArtifactView: View {
    let part: ChatContentPart

    @State private var isExpanded = true
    @State private var contentHeight: CGFloat = 400
    @State private var loadError: String?

    private var isVerified: Bool { part.hasVerifiedArtifactOutput }
    private var html: String { part.artifactHTML ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "macwindow")
                        .foregroundStyle(TBPalette.muted)
                    Text(part.artifactTitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(TBPalette.foreground)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if !isVerified {
                        Text("Generating…")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(TBPalette.muted)
                    } else {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TBPalette.muted)
                    }
                }
                .frame(minHeight: 42)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!isVerified)

            if isExpanded {
                if let loadError {
                    Label(loadError, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(TBPalette.muted)
                        .frame(maxWidth: .infinity, minHeight: 120, alignment: .leading)
                        .padding(12)
                } else if html.isEmpty {
                    ProgressView(nativeString( "Waiting for artifact…"))
                        .frame(maxWidth: .infinity, minHeight: 140)
                } else {
                    SandboxedArtifactWebView(
                        html: html,
                        allowsScripts: isVerified,
                        height: $contentHeight,
                        loadError: $loadError
                    )
                    .frame(height: min(max(contentHeight, 120), 20_000))
                }
            }
        }
        .padding(.horizontal, 12)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(TBPalette.border, lineWidth: 0.8))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .onChange(of: html) { _, _ in
            loadError = nil
            contentHeight = 400
        }
    }
}

private struct SandboxedArtifactWebView: UIViewRepresentable {
    let html: String
    let allowsScripts: Bool
    @Binding var height: CGFloat
    @Binding var loadError: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(height: $height, loadError: $loadError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = allowsScripts

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .white
        webView.scrollView.backgroundColor = .white
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.accessibilityLabel = nativeString( "Interactive artifact")
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedHTML != html || context.coordinator.loadedScripts != allowsScripts else { return }
        context.coordinator.loadedHTML = html
        context.coordinator.loadedScripts = allowsScripts
        webView.configuration.defaultWebpagePreferences.allowsContentJavaScript = allowsScripts
        webView.loadHTMLString(SandboxedArtifactDocument.wrap(html), baseURL: SandboxedArtifactDocument.origin)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding private var height: CGFloat
        @Binding private var loadError: String?

        var loadedHTML: String?
        var loadedScripts: Bool?

        init(height: Binding<CGFloat>, loadError: Binding<String?>) {
            self._height = height
            self._loadError = loadError
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript(
                "Math.max(120, Math.min(20000, Math.ceil(document.body ? document.body.scrollHeight : 400)))"
            ) { [weak self] result, _ in
                guard let measuredHeight = result as? NSNumber else { return }
                DispatchQueue.main.async {
                    self?.height = CGFloat(measuredHeight.doubleValue)
                }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            loadError = nativeString( "This artifact could not be displayed.")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            loadError = nativeString( "This artifact could not be displayed.")
        }

        @MainActor
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            if navigationAction.targetFrame?.isMainFrame == true,
               navigationAction.request.url == SandboxedArtifactDocument.origin { return .allow }
            guard navigationAction.targetFrame?.isMainFrame == true,
                  let scheme = navigationAction.request.url?.scheme?.lowercased(),
                  scheme == "about" || scheme == "data" || scheme == "blob" else {
                return .cancel
            }
            return .allow
        }
    }
}

/// Mirrors the Tauri artifact CSP. Preview content keeps scripts disabled; verified content can
/// run inline scripts/eval and data/blob media, while the policy denies network connections.
enum SandboxedArtifactDocument {
    // A reserved, non-resolving origin avoids WebKit muting inline exception
    // details as cross-origin "Script error." The offline CSP still denies fetches.
    static let origin = URL(string: "https://thunderbolt-artifact.invalid/")!
    static let contentSecurityPolicy =
        "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:; base-uri 'none'; form-action 'none'"

    static func wrap(_ html: String) -> String {
        let csp = #"<meta http-equiv="Content-Security-Policy" content="\#(contentSecurityPolicy)">"#
        let runtimeGuard = """
        <script>
        (function () {
          function showError(message) {
            function mount() {
              if (!document.body || document.getElementById('tb-artifact-runtime-error')) return;
              var strip = document.createElement('div');
              strip.id = 'tb-artifact-runtime-error';
              strip.setAttribute('role', 'alert');
              strip.textContent = 'Artifact error: ' + String(message || 'Script failed').slice(0, 2000);
              strip.style.cssText = 'position:sticky;top:0;z-index:2147483647;padding:8px 12px;background:#fff0e8;color:#782b1b;border-bottom:1px solid #dfb7a8;font:13px -apple-system,sans-serif;white-space:pre-wrap';
              document.body.insertBefore(strip, document.body.firstChild);
            }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
            else mount();
          }
          window.addEventListener('error', function (event) {
            if (!event.target || event.target === window) showError(event.message);
          }, true);
          window.addEventListener('unhandledrejection', function (event) {
            var reason = event.reason;
            showError(reason && reason.message ? reason.message : String(reason));
          });
        })();
        </script>
        """

        if let headStart = html.range(of: #"<head\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            return html.replacingCharacters(in: headStart.upperBound..<headStart.upperBound, with: csp + runtimeGuard)
        }
        if let htmlStart = html.range(of: #"<html\b[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            return html.replacingCharacters(in: htmlStart.upperBound..<htmlStart.upperBound, with: "<head>\(csp)\(runtimeGuard)</head>")
        }
        return "<!doctype html><html><head>\(csp)\(runtimeGuard)</head><body>\(html)</body></html>"
    }
}
