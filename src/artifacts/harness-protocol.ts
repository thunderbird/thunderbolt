/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Message the in-iframe harness posts through its document-bound port. The `artifactNonce`
 * correlates the message with the render that produced it, so a page cannot
 * spoof another render's result.
 */
import { z } from 'zod'

import { clampedString } from '@shared/lib/clamped-string'

export type HarnessMessage =
  | { artifactNonce: string; type: 'artifact-ready' }
  | { artifactNonce: string; type: 'artifact-disconnect' }
  | { artifactNonce: string; type: 'artifact-height'; height: number }
  | {
      artifactNonce: string
      type: 'artifact-error'
      reason: 'exception' | 'unhandled-rejection'
      detail: string
    }
  /** Reply to a {@link HarnessRequest}, correlated by `id`. */
  | { artifactNonce: string; type: 'artifact-reply'; id: number; result: unknown; error?: string }

export type HarnessRequest = {
  artifactNonce: string
  type: 'artifact-request'
  id: number
  method: string
  params: unknown
}

/**
 * Content-Security-Policy applied to every rendered artifact via an injected
 * `<meta http-equiv>` tag. Artifacts render from self-contained content: inline
 * JS/CSS run (and may `eval`), and images/fonts/media may use `data:`/`blob:` URIs,
 * but network subresources and scripted requests are denied — `connect-src`
 * falls back to `default-src 'none'`, so no `fetch`/XHR/WebSocket or external scripts, styles, fonts, or
 * images can load. Combined with the iframe `sandbox` (never `allow-same-origin`),
 * an artifact cannot reach the parent origin or load network subresources.
 *
 * Residual limitation (no clean CSP/sandbox token closes it): a script can still
 * navigate its OWN frame (`location = ...`, `<meta http-equiv=refresh>`), which
 * issues an outbound GET the fetch directives never see — so an artifact must not
 * be trusted with sensitive user-entered input.
 */
export const artifactCsp =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; worker-src blob:; base-uri 'none'; form-action 'none'"

/** Enable local submit handlers while CSP blocks outbound forms; retain an opaque origin. */
export const artifactSandbox = 'allow-scripts allow-forms'

const cspMetaTag = (): string => `<meta http-equiv="Content-Security-Policy" content="${artifactCsp}">`

/** Turn a harness error message into a single human-readable line. */
export const formatHarnessError = (message: Extract<HarnessMessage, { type: 'artifact-error' }>): string => {
  const label = harnessErrorLabels[message.reason]
  return `${label}: ${message.detail}`
}

/**
 * What each failure reads as to the user.
 *
 * A lookup rather than a ternary chain, so adding a `reason` to the union is a
 * compile error here rather than a silent fall-through to "Uncaught error".
 */
const harnessErrorLabels: Record<Extract<HarnessMessage, { type: 'artifact-error' }>['reason'], string> = {
  exception: 'Uncaught error',
  'unhandled-rejection': 'Unhandled promise rejection',
}

/** Page scripts can overwrite their harness, so the host bounds all reported diagnostic text. */
const harnessMessageSchema = z.discriminatedUnion('type', [
  z.object({ artifactNonce: z.string(), type: z.literal('artifact-ready') }),
  z.object({ artifactNonce: z.string(), type: z.literal('artifact-disconnect') }),
  z.object({ artifactNonce: z.string(), type: z.literal('artifact-height'), height: z.number().finite() }),
  z.object({
    artifactNonce: z.string(),
    type: z.literal('artifact-error'),
    reason: z.enum(['exception', 'unhandled-rejection']),
    detail: clampedString(2_000),
  }),
  z.object({
    artifactNonce: z.string(),
    type: z.literal('artifact-reply'),
    id: z.number().int(),
    result: z.unknown(),
    error: clampedString(2_000).optional(),
  }),
])

/** Validate messages received through the bound document port; callers validate each method's result. */
export const parseHarnessMessage = (data: unknown, nonce: string): HarnessMessage | null => {
  const parsed = harnessMessageSchema.safeParse(data)
  if (!parsed.success || parsed.data.artifactNonce !== nonce) {
    return null
  }
  return parsed.data
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
 *
 */
const harnessScript = (nonce: string): string => `<script>
(function () {
  var NONCE = ${JSON.stringify(nonce)};
  var channel = new MessageChannel();
  // Bound diagnostics both here and in the host-side schema.
  var MAX_DETAIL = 2000;
  function send(msg) {
    msg.artifactNonce = NONCE;
    try { channel.port1.postMessage(msg); } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    var t = e.target;
    // Ignore failed subresource loads (img/script/link 404s); only report real exceptions.
    if (t && t !== window && t.tagName) {
      return;
    }
    send({ type: 'artifact-error', reason: 'exception', detail: ((e.message || 'Error') + (e.filename ? ' @ ' + e.filename : '') + (e.lineno ? ':' + e.lineno : '')).slice(0, MAX_DETAIL) });
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    var message = r && typeof r.message === 'string' ? r.message : '';
    var stack = r && typeof r.stack === 'string' ? r.stack : '';
    var detail = message && stack && stack.split('\\n', 1)[0].indexOf(message) === -1 ? message + '\\n' + stack : stack || message || String(r);
    send({ type: 'artifact-error', reason: 'unhandled-rejection', detail: detail });
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
  window.__artifactHandlers = window.__artifactHandlers || {};
  // Host-to-guest requests. Handlers are registered by the artifact channel
  // module on window.__artifactHandlers; an unknown method replies null rather
  // than going silent, so the host resolves instead of waiting out its timeout.
  channel.port1.onmessage = function (e) {
    var d = e.data;
    if (!d || d.artifactNonce !== NONCE || d.type !== 'artifact-request') { return; }
    var handlers = window.__artifactHandlers || {};
    var handler = handlers[d.method];
    var reply = function (result) { send({ type: 'artifact-reply', id: d.id, result: result }); };
    // Request failures belong to that operation, not the page's runtime health.
    var replyFailed = function (err) {
      send({ type: 'artifact-reply', id: d.id, result: null, error: String((err && err.message) || err).slice(0, MAX_DETAIL) });
    };
    if (!handler) { reply(null); return; }
    try {
      Promise.resolve(handler(d.params)).then(reply, replyFailed);
    } catch (err) { replyFailed(err); }
  };

  // A port belongs to this document, unlike WindowProxy. Close on pagehide too:
  // a BFCache restoration must never replay input queued before navigation.
  window.addEventListener('pagehide', function () {
    send({ type: 'artifact-disconnect' });
    channel.port1.close();
  }, { once: true });

  // Bootstrap before any artifact script runs. No host request is ever sent via
  // WindowProxy, so a replacement document cannot receive input or a new port.
  parent.postMessage({ artifactNonce: NONCE, type: 'artifact-connect' }, '*', [channel.port2]);

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

/**
 * Build the envelope for a host→guest request.
 *
 * Sent only through the channel established by the original document. Never
 * send requests to the frame's WindowProxy, which survives navigation.
 */
export const artifactRequest = (nonce: string, id: number, method: string, params: unknown): HarnessRequest => ({
  artifactNonce: nonce,
  type: 'artifact-request',
  id,
  method,
  params,
})

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
export const wrapArtifactHtml = (html: string, nonce: string, driverSource = ''): string =>
  injectIntoHead(html, `${cspMetaTag()}${harnessScript(nonce)}<script>${driverSource}</script>`)

/**
 * Wrap the (partial) HTML for the scripts-off streaming preview: inject ONLY the
 * offline CSP `<meta>` (no harness — the preview iframe runs no scripts), so the
 * live preview is bound by the same no-network policy and a streaming artifact
 * cannot beacon out via a subresource (`<img>`, CSS `url()`) before it's verified.
 */
export const wrapArtifactPreviewHtml = (html: string): string => injectIntoHead(html, cspMetaTag())
