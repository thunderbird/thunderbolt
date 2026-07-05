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
 * `<meta http-equiv>` tag. `null` means unrestricted network — the iframe
 * `sandbox` (which never includes `allow-same-origin`) still isolates the
 * parent origin's DOM, cookies, and storage. This is the single knob to tighten
 * what artifacts may load/connect to (e.g. `default-src 'self'; connect-src 'none'`).
 */
export const artifactCsp: string | null = null

const cspMetaTag = (): string =>
  artifactCsp ? `<meta http-equiv="Content-Security-Policy" content="${artifactCsp}">` : ''

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
 * before any agent handler. Failed subresource loads (a 404 image/font/CDN asset)
 * are deliberately ignored — a non-essential asset shouldn't fail an otherwise
 * working page, and a missing essential script surfaces as an exception anyway.
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
  function reportHeight() {
    var el = document.documentElement;
    var h = Math.max(el ? el.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
    send({ type: 'artifact-height', height: h });
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      send({ type: 'artifact-ready' });
      reportHeight();
      if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
        new ResizeObserver(reportHeight).observe(document.documentElement);
      }
    }, 0);
  });
})();
</script>`

/**
 * Wrap agent-authored HTML with the network-policy `<meta>` and the
 * error-reporting harness, injected at the very start of `<head>` (created if
 * absent) so the harness runs before any agent script. Used identically for
 * hidden verification and visible rendering, so what we verify is exactly what
 * we show.
 */
export const wrapArtifactHtml = (html: string, nonce: string): string => {
  const injected = `${cspMetaTag()}${harnessScript(nonce)}`

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
