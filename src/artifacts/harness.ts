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
  /** Reply to a {@link HarnessRequest}, correlated by `id`. */
  | { artifactNonce: string; type: 'artifact-reply'; id: number; result: unknown }
  /**
   * The user highlighted (or cleared) text inside the artifact.
   *
   * Reported by the guest because a host cannot read the selection inside a
   * frame it doesn't share an origin with — that isolation is the point, so the
   * page volunteers it. `null` means the selection was cleared.
   */
  | { artifactNonce: string; type: 'artifact-selection'; selection: ArtifactTextSelection | null }

/**
 * A question the host asks the artifact.
 *
 * Artifacts were one-way until now — the page reported its height and its errors
 * and nothing was ever sent back down. Asking "what's inside this rectangle?"
 * needs an answer, so the channel gains ids and replies.
 *
 * Targeted with `'*'` rather than a real origin: the frame is sandboxed without
 * `allow-same-origin`, so its origin is opaque and there is no value to pin.
 * `postMessage` on a specific `contentWindow` still reaches only that frame, and
 * the nonce remains the thing that proves which render answered.
 */
/** Highlighted text plus where it sits in the artifact's own viewport. */
export type ArtifactTextSelection = {
  text: string
  rect?: { x: number; y: number; width: number; height: number }
}

/** One thing a marquee covered, ready to become a composer chip. */
export type ArtifactSelectionItem = { id: string; label: string; text: string }

/** Method name the host uses to resolve a marquee to content. */
export const artifactSelectionQueryMethod = 'selection/query'

export type HarnessRequest = {
  artifactNonce: string
  type: 'artifact-request'
  id: number
  method: string
  params: unknown
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

/** Monotonic across all frames; only ever compared against replies from one. */
let nextRequestId = 1

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
  // Host-to-guest requests. Handlers are registered by the artifact channel
  // module on window.__artifactHandlers; an unknown method replies null rather
  // than going silent, so the host resolves instead of waiting out its timeout.
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.artifactNonce !== NONCE || d.type !== 'artifact-request') { return; }
    var handlers = window.__artifactHandlers || {};
    var handler = handlers[d.method];
    var reply = function (result) { send({ type: 'artifact-reply', id: d.id, result: result }); };
    if (!handler) { reply(null); return; }
    try {
      Promise.resolve(handler(d.params)).then(reply, function () { reply(null); });
    } catch (err) { reply(null); }
  });

  // ---- selection --------------------------------------------------------
  // Ported from the mini-app SDK's hit-test so both surfaces answer a marquee
  // the same way. Defined AFTER the error listeners above, deliberately: the
  // listeners must win the race against agent code, this need not.
  var CONTAINMENT = 0.6;
  var CANDIDATES = '[data-tb-select], tr, li, blockquote, figure, p, h1, h2, h3, h4, h5, h6';
  var MAX_ITEMS = 50;

  function ratio(el, box) {
    var r = el.getBoundingClientRect();
    var a = r.width * r.height;
    if (a <= 0) { return 0; }
    var w = Math.min(r.x + r.width, box.x + box.width) - Math.max(r.x, box.x);
    var h = Math.min(r.y + r.height, box.y + box.height) - Math.max(r.y, box.y);
    return w > 0 && h > 0 ? (w * h) / a : 0;
  }

  function labelFor(el, i) {
    var explicit = el.getAttribute('data-tb-label');
    if (explicit) { return explicit; }
    var cell = el.querySelector('td, th');
    var cellText = cell && cell.textContent ? cell.textContent.trim() : '';
    if (cellText) { return cellText; }
    var t = (el.textContent || '').trim();
    return t ? t.slice(0, 40) + (t.length > 40 ? '…' : '') : 'Item ' + (i + 1);
  }

  // Read a table row as "Header: value" pairs so a bare number reaches the model
  // attached to the column it came from.
  function describeRow(el) {
    var cells = Array.prototype.slice.call(el.querySelectorAll('td'));
    if (!cells.length) { return null; }
    var table = el.closest ? el.closest('table') : null;
    var heads = table ? Array.prototype.slice.call(table.querySelectorAll('thead th')) : [];
    if (heads.length !== cells.length) {
      return cells.map(function (c) { return (c.textContent || '').trim(); }).join(' | ');
    }
    return cells.map(function (c, i) { return (heads[i].textContent || '').trim() + ': ' + (c.textContent || '').trim(); }).join(', ');
  }

  window.__artifactHandlers = window.__artifactHandlers || {};
  window.__artifactHandlers['selection/query'] = function (params) {
    var box = params && params.rect;
    if (!box) { return { items: [] }; }
    var hits = Array.prototype.slice.call(document.querySelectorAll(CANDIDATES)).filter(function (el) {
      return ratio(el, box) >= CONTAINMENT;
    });
    // Collapse nested matches to their outermost ancestor, so a box over a table
    // row yields the row and not the row plus each of its cells.
    var outer = hits.filter(function (el) {
      return !hits.some(function (other) { return other !== el && other.contains(el); });
    });
    var items = [];
    outer.slice(0, MAX_ITEMS).forEach(function (el, i) {
      var text = describeRow(el) || (el.textContent || '').trim();
      if (text) { items.push({ id: i + '-' + labelFor(el, i), label: labelFor(el, i), text: text }); }
    });
    return { items: items };
  };

  // Report highlights so the host can float its "Ask about this" control. Debounced
  // because selectionchange fires per character while dragging, and re-sent on
  // scroll so a placed control doesn't strand itself.
  var selTimer;
  var lastSel = null;
  function readSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { return null; }
    var text = sel.toString().trim();
    if (!text) { return null; }
    var b = sel.getRangeAt(0).getBoundingClientRect();
    var rect = b.width > 0 || b.height > 0 ? { x: b.x, y: b.y, width: b.width, height: b.height } : undefined;
    return { text: text, rect: rect };
  }
  function reportSelection() {
    var cur = readSelection();
    var key = cur ? cur.text + '@' + (cur.rect ? cur.rect.x + ',' + cur.rect.y : 'n') : null;
    if (key === lastSel) { return; }
    lastSel = key;
    send({ type: 'artifact-selection', selection: cur });
  }
  function onSelectionChange() {
    clearTimeout(selTimer);
    selTimer = setTimeout(reportSelection, 180);
  }
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('scroll', onSelectionChange, { passive: true, capture: true });

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
 * Send a request into an artifact frame and wait for its reply.
 *
 * Resolves `null` on timeout rather than rejecting: the caller is host UI
 * reacting to a gesture, and "the page didn't answer" is a normal outcome for
 * model-written HTML that may have thrown before registering a handler. A
 * rejection here would turn that into an unhandled error on a pointer event.
 *
 * Target origin is `'*'` because a sandboxed frame without `allow-same-origin`
 * has an opaque origin — there is nothing to pin. The message still reaches only
 * this frame, and the nonce proves which render replied.
 */
export const requestFromArtifact = (
  contentWindow: Window | null,
  nonce: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> =>
  new Promise((resolve) => {
    if (!contentWindow) {
      resolve(null)
      return
    }

    const id = nextRequestId++
    let settled = false

    const settle = (value: unknown) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(value)
    }

    const onMessage = (event: MessageEvent) => {
      const reply = parseHarnessMessage(event, contentWindow, nonce)
      if (reply?.type === 'artifact-reply' && reply.id === id) {
        settle(reply.result)
      }
    }

    const timer = setTimeout(() => settle(null), timeoutMs)
    window.addEventListener('message', onMessage)

    const request: HarnessRequest = { artifactNonce: nonce, type: 'artifact-request', id, method, params }
    contentWindow.postMessage(request, '*')
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
export const wrapArtifactHtml = (html: string, nonce: string): string =>
  injectIntoHead(html, `${cspMetaTag()}${harnessScript(nonce)}`)

/**
 * Wrap the (partial) HTML for the scripts-off streaming preview: inject ONLY the
 * offline CSP `<meta>` (no harness — the preview iframe runs no scripts), so the
 * live preview is bound by the same no-network policy and a streaming artifact
 * cannot beacon out via a subresource (`<img>`, CSS `url()`) before it's verified.
 */
export const wrapArtifactPreviewHtml = (html: string): string => injectIntoHead(html, cspMetaTag())
