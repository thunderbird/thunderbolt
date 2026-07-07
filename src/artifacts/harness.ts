/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Message the in-iframe harness posts to the parent window. The `artifactNonce`
 * correlates the message with the render that produced it, so a page cannot
 * spoof another render's result.
 */
export type HarnessMessage =
  | { artifactNonce: string; type: 'artifact-ready' }
  | { artifactNonce: string; type: 'artifact-height'; height: number }
  | {
      artifactNonce: string
      type: 'artifact-error'
      reason: 'exception' | 'unhandled-rejection'
      detail: string
    }

/**
 * Content-Security-Policy applied to every rendered artifact via an injected
 * `<meta http-equiv>` tag. Artifacts are fully self-contained and OFFLINE: inline
 * JS/CSS run (and may `eval`), and images/fonts/media may use `data:`/`blob:` URIs,
 * but all network access is denied — `connect-src` falls back to `default-src
 * 'none'`, so no `fetch`/XHR/WebSocket, and no external scripts, styles, fonts, or
 * images can load. Combined with the iframe `sandbox` (never `allow-same-origin`),
 * an artifact can neither reach the parent origin nor exfiltrate over the network.
 *
 * Residual limitation (no clean CSP/sandbox token closes it): a script can still
 * navigate its OWN frame (`location = ...`, `<meta http-equiv=refresh>`), which
 * issues an outbound GET the fetch directives never see — so an artifact must not
 * be trusted with sensitive user-entered input.
 */
export const artifactCsp =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:; base-uri 'none'; form-action 'none'"

const cspMetaTag = (): string => `<meta http-equiv="Content-Security-Policy" content="${artifactCsp}">`

/** Turn a harness error message into a single human-readable line. */
export const formatHarnessError = (message: Extract<HarnessMessage, { type: 'artifact-error' }>): string => {
  const label = message.reason === 'unhandled-rejection' ? 'Unhandled promise rejection' : 'Uncaught error'
  return `${label}: ${message.detail}`
}

/**
 * Validate and decode a `postMessage` from an artifact iframe: it must originate
 * from that iframe's own window and carry the matching per-render nonce. Returns
 * the typed message, or `null` to ignore. Centralized so the source/nonce checks
 * can't drift between the verifier and the visible renderer.
 */
export const parseHarnessMessage = (
  event: MessageEvent,
  contentWindow: Window | null,
  nonce: string,
): HarnessMessage | null => {
  if (event.source !== contentWindow) {
    return null
  }
  const data = event.data as HarnessMessage | undefined
  if (!data || data.artifactNonce !== nonce) {
    return null
  }
  return data
}

/**
 * The error/ready-reporting script, injected as the FIRST script in the
 * artifact document so it wins the race to install listeners before any
 * agent-authored script can throw or overwrite `window.onerror`.
 *
 * A capture-phase `error` listener is used so real script exceptions are caught
 * before any agent handler. Failed subresource loads (a 404 or CSP-blocked
 * image/font/script) are deliberately ignored so a non-essential asset can't fail
 * an otherwise-working page. Inline-JS syntax errors are caught earlier by the
 * static check, and external scripts (which the offline CSP blocks) are rejected
 * there too — so ignoring subresource errors here loses no real coverage.
 */
const harnessScript = (nonce: string): string => `<script>
(function () {
  var NONCE = ${JSON.stringify(nonce)};
  function send(msg) {
    msg.artifactNonce = NONCE;
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    // Ignore failed subresource loads (img/script/link 404s); only report real exceptions.
    if (t && t !== window && t.tagName) {
      return;
    }
    send({ type: 'artifact-error', reason: 'exception', detail: (e.message || 'Error') + (e.filename ? ' @ ' + e.filename : '') + (e.lineno ? ':' + e.lineno : '') });
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send({ type: 'artifact-error', reason: 'unhandled-rejection', detail: (r && (r.stack || r.message)) || String(r) });
  });
  function measureAndSend() {
    // body.scrollHeight (not documentElement) so the frame can also SHRINK — the root's
    // scrollHeight is floored at the viewport height the parent just set, which would make
    // the reported height monotonic and leave dead space under short/collapsing artifacts.
    var h = document.body ? document.body.scrollHeight : (document.documentElement ? document.documentElement.scrollHeight : 0);
    send({ type: 'artifact-height', height: h });
  }
  var rafPending = false;
  function reportHeight() {
    // Coalesce ResizeObserver bursts (animations, transitions) to one report per frame so
    // we don't postMessage — and re-render the parent — dozens of times per second.
    if (rafPending) { return; }
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; measureAndSend(); });
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      send({ type: 'artifact-ready' });
      measureAndSend();
      if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
        new ResizeObserver(reportHeight).observe(document.documentElement);
      }
    }, 0);
  });
})();
</script>`

/** Splice `injected` markup into the document `<head>` (creating one if absent), before any agent content. */
const injectIntoHead = (html: string, injected: string): string => {
  const headMatch = html.match(/<head\b[^>]*>/i)
  if (headMatch?.index !== undefined) {
    const at = headMatch.index + headMatch[0].length
    return html.slice(0, at) + injected + html.slice(at)
  }

  const htmlMatch = html.match(/<html\b[^>]*>/i)
  if (htmlMatch?.index !== undefined) {
    const at = htmlMatch.index + htmlMatch[0].length
    return html.slice(0, at) + `<head>${injected}</head>` + html.slice(at)
  }

  const doctypeMatch = html.match(/<!doctype[^>]*>/i)
  if (doctypeMatch?.index !== undefined) {
    const at = doctypeMatch.index + doctypeMatch[0].length
    return html.slice(0, at) + injected + html.slice(at)
  }

  return injected + html
}

/**
 * Wrap agent-authored HTML with the network-policy `<meta>` and the
 * error-reporting harness, injected at the very start of `<head>` (created if
 * absent) so the harness runs before any agent script. Used identically for
 * hidden verification and visible rendering, so what we verify is exactly what
 * we show.
 *
 * SECURITY INVARIANT: a visible render only happens after verification passes,
 * and both use this exact wrapping — so if the injection ever lands somewhere
 * inert (e.g. a page that hides `<head>` inside a comment), verification simply
 * never fires `artifact-ready` and the artifact is rejected rather than shown
 * without its CSP. Do not add a render path that skips verification.
 */
export const wrapArtifactHtml = (html: string, nonce: string): string =>
  injectIntoHead(html, `${cspMetaTag()}${harnessScript(nonce)}`)

/**
 * Wrap the (partial) HTML for the scripts-off streaming preview: inject ONLY the
 * offline CSP `<meta>` (no harness — the preview iframe runs no scripts), so the
 * live preview is bound by the same no-network policy and a streaming artifact
 * cannot beacon out via a subresource (`<img>`, CSS `url()`) before it's verified.
 */
export const wrapArtifactPreviewHtml = (html: string): string => injectIntoHead(html, cspMetaTag())
