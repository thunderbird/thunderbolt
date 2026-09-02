/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Message the in-iframe harness posts to the parent window. The `artifactNonce`
 * correlates the message with the render that produced it, so a page cannot
 * spoof another render's result.
 */
import { z } from 'zod'

import { clampedString } from '@shared/lib/clamped-string'

import type { SurfaceSelectionItem, SurfaceTextSelection } from '@/components/embedded/types'

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
   * What the artifact currently shows, in prose the model can read.
   *
   * Derived by the harness rather than authored, because the page is written by
   * the model and has no idea our APIs exist — asking it to opt in would make
   * this work for new artifacts and never for the ones already in a transcript.
   * A page that wants to do better can set `window.__artifactContext`.
   */
  | { artifactNonce: string; type: 'artifact-context'; context: ArtifactContext }
  /**
   * The user highlighted (or cleared) text inside the artifact.
   *
   * Reported by the guest because a host cannot read the selection inside a
   * frame it doesn't share an origin with — that isolation is the point, so the
   * page volunteers it. `null` means the selection was cleared.
   */
  | { artifactNonce: string; type: 'artifact-selection'; selection: ArtifactTextSelection | null }

/** A short description of what the artifact is showing right now. */
export type ArtifactContext = { title: string; summary: string }

/** Highlighted text plus where it sits in the artifact's own viewport. */
/*
 * Aliases, not copies. Both shapes existed here verbatim as well as in
 * `components/embedded/types.ts` and (as zod schemas) in the Mini App protocol,
 * type-checking across the boundary only because all three happened to be
 * structurally identical — so a field added to one silently never reached the
 * others. The shared module is the declaration; these names stay because the
 * artifact code reads better with them.
 */
export type ArtifactTextSelection = SurfaceTextSelection

export type ArtifactSelectionItem = SurfaceSelectionItem

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
const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
})

/**
 * Bounds on everything an artifact can say.
 *
 * The caps in the injected script are advisory only: the page owns its own
 * document and knows its own nonce, so it can overwrite the harness handlers or
 * simply post whatever it likes. Anything trusted has to be enforced up here.
 *
 * This surface had no schema at all, which is backwards — an artifact is the
 * *less* trusted of the two embedded surfaces (its HTML is model-written, and
 * often shaped by whatever the model just read), while the Mini App path bounds
 * every field. The numbers mirror that path so the two agree.
 *
 * The bounds are prompt-and-memory budgets, not correctness constraints, and
 * every field they guard is free text the artifact derives from its own DOM.
 * {@link clampedString} explains why they clamp instead of rejecting; the Mini
 * App protocol uses the same helper, so the two surfaces cannot drift on it.
 */
const harnessMessageSchema = z.discriminatedUnion('type', [
  z.object({ artifactNonce: z.string(), type: z.literal('artifact-ready') }),
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
  }),
  z.object({
    artifactNonce: z.string(),
    type: z.literal('artifact-context'),
    context: z.object({ title: clampedString(200), summary: clampedString(20_000) }),
  }),
  z.object({
    artifactNonce: z.string(),
    type: z.literal('artifact-selection'),
    selection: z.object({ text: clampedString(20_000), rect: rectSchema.optional() }).nullable(),
  }),
])

/** Items a marquee resolved to. Validated separately: it rides `artifact-reply`'s
 *  `unknown` result, which the caller narrows once it knows what it asked. */
export const artifactSelectionItemsSchema = z.object({
  items: z
    .array(z.object({ id: clampedString(200), label: clampedString(500), text: clampedString(5_000) }))
    // Clamped, not capped: the harness sends at most 50, but a hand-rolled one
    // sending 60 would otherwise lose the marquee result entirely.
    .max(500)
    .transform((items) => items.slice(0, 50)),
})

export const parseHarnessMessage = (
  event: MessageEvent,
  contentWindow: Window | null,
  nonce: string,
): HarnessMessage | null => {
  if (event.source !== contentWindow) {
    return null
  }
  const parsed = harnessMessageSchema.safeParse(event.data)
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
 */
const harnessScript = (nonce: string): string => `<script>
(function () {
  var NONCE = ${JSON.stringify(nonce)};
  // Trimmed here as well as host-side. The host clamps so an overrun is never
  // silently fatal; this keeps a select-all on a long page, or a deep stack
  // trace, from crossing postMessage at full size in the first place.
  var MAX_DETAIL = 2000;
  var MAX_SELECTION = 20000;
  var MAX_ITEM_TEXT = 5000;
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
    send({ type: 'artifact-error', reason: 'exception', detail: ((e.message || 'Error') + (e.filename ? ' @ ' + e.filename : '') + (e.lineno ? ':' + e.lineno : '')).slice(0, MAX_DETAIL) });
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send({ type: 'artifact-error', reason: 'unhandled-rejection', detail: String((r && (r.stack || r.message)) || r).slice(0, MAX_DETAIL) });
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
      if (text) { items.push({ id: i + '-' + labelFor(el, i), label: labelFor(el, i), text: text.slice(0, MAX_ITEM_TEXT) }); }
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
    return { text: text.slice(0, MAX_SELECTION), rect: rect };
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

  // ---- context ----------------------------------------------------------
  // A digest of what the page currently shows, so asking "what does this chart
  // say?" doesn't require the model to re-read HTML it may no longer hold.
  // Derived, not authored: the page's author is the model, which has never
  // heard of this API. A page may override by setting window.__artifactContext.
  var MAX_SUMMARY = 1500;

  function deriveContext() {
    var override = window.__artifactContext;
    if (override && override.summary) {
      return { title: String(override.title || document.title || 'Artifact'), summary: String(override.summary).slice(0, MAX_SUMMARY) };
    }
    var h1 = document.querySelector('h1');
    var title = (document.title || (h1 && h1.textContent) || 'Artifact').trim();
    // Headings first: they're the page's own outline, and they survive
    // truncation better than a wall of body text would.
    var heads = Array.prototype.slice.call(document.querySelectorAll('h1, h2, h3'))
      .map(function (h) { return (h.textContent || '').trim(); })
      .filter(Boolean);
    var body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    var summary = (heads.length ? heads.join(' · ') + '\\n' : '') + body.replace(/\\s+/g, ' ').trim();
    return { title: title, summary: summary.slice(0, MAX_SUMMARY) };
  }

  var lastContext = '';
  function reportContext() {
    var ctx = deriveContext();
    var key = ctx.title + '\\u0000' + ctx.summary;
    if (key === lastContext) { return; }
    lastContext = key;
    send({ type: 'artifact-context', context: ctx });
  }

  var ctxTimer;
  function scheduleContext() {
    clearTimeout(ctxTimer);
    // Debounced: an interactive artifact can mutate on every animation frame,
    // and the host only needs to know where it settled.
    ctxTimer = setTimeout(reportContext, 250);
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      send({ type: 'artifact-ready' });
      measureAndSend();
      reportContext();
      if (typeof MutationObserver !== 'undefined' && document.body) {
        new MutationObserver(scheduleContext).observe(document.body, { subtree: true, childList: true, characterData: true });
      }
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
 * Targeted with `'*'` by the caller because the frame is sandboxed without
 * `allow-same-origin`: its origin is opaque, so there is nothing to pin. The
 * message still reaches only that frame, and the nonce proves which render
 * answered.
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
export const wrapArtifactHtml = (html: string, nonce: string): string =>
  injectIntoHead(html, `${cspMetaTag()}${harnessScript(nonce)}`)

/**
 * Wrap the (partial) HTML for the scripts-off streaming preview: inject ONLY the
 * offline CSP `<meta>` (no harness — the preview iframe runs no scripts), so the
 * live preview is bound by the same no-network policy and a streaming artifact
 * cannot beacon out via a subresource (`<img>`, CSS `url()`) before it's verified.
 */
export const wrapArtifactPreviewHtml = (html: string): string => injectIntoHead(html, cspMetaTag())
