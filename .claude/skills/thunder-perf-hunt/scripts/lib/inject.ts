/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browser-context instrumentation injected via `page.addInitScript`. These run
 * BEFORE the app's own scripts so we can (a) install PerformanceObservers with
 * `buffered: true` to catch metrics that fire during first paint, and (b) plant
 * a minimal React DevTools global hook so React reports every commit to us —
 * both without touching app source or loading any cross-origin script (the app
 * ships COEP: credentialless, which would block a CDN <script>).
 *
 * Exported as source strings because they execute in the page realm, not Node;
 * this keeps our typed Node code free of `any`-typed browser-global access.
 */

/** Installed at document start in every page/frame. Populates window.__PERF_HUNT__. */
export const INIT_SCRIPT = /* js */ `
(() => {
  if (window.__PERF_HUNT__) return;
  const store = {
    lcp: null, cls: 0, clsTarget: null, inp: 0, inpTarget: null,
    fcp: null, ttfb: null, longTasks: [], loaf: [],
    renders: {}, commits: 0,
  };
  window.__PERF_HUNT__ = store;

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return undefined;
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel += '#' + node.id; parts.unshift(sel); break; }
      const cls = (node.className && node.className.baseVal !== undefined)
        ? node.className.baseVal : node.className;
      if (cls && typeof cls === 'string') {
        const c = cls.trim().split(/\\s+/).slice(0, 2).join('.');
        if (c) sel += '.' + c;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const observe = (type, cb, extra) => {
    try { new PerformanceObserver((l) => cb(l.getEntries())).observe({ type, buffered: true, ...(extra || {}) }); } catch (e) {}
  };

  observe('largest-contentful-paint', (es) => {
    for (const e of es) store.lcp = { value: e.startTime, target: cssPath(e.element), url: e.url || undefined };
  });
  observe('layout-shift', (es) => {
    for (const e of es) {
      if (e.hadRecentInput) continue;
      store.cls += e.value;
      const src = e.sources && e.sources[0] && e.sources[0].node;
      if (src) store.clsTarget = cssPath(src);
    }
  });
  observe('paint', (es) => {
    for (const e of es) if (e.name === 'first-contentful-paint') store.fcp = e.startTime;
  });
  observe('navigation', (es) => { for (const e of es) store.ttfb = e.responseStart; });
  observe('event', (es) => {
    for (const e of es) if (e.interactionId && e.duration > store.inp) {
      store.inp = e.duration; store.inpTarget = cssPath(e.target);
    }
  }, { durationThreshold: 40 });
  observe('longtask', (es) => {
    for (const e of es) store.longTasks.push({
      duration: e.duration, startTime: e.startTime,
      attribution: (e.attribution && e.attribution[0] && e.attribution[0].name) || 'unknown',
    });
  });
  observe('long-animation-frame', (es) => {
    for (const e of es) {
      let forced = 0;
      for (const s of (e.scripts || [])) forced += s.forcedStyleAndLayoutDuration || 0;
      store.loaf.push({
        duration: e.duration, blockingDuration: e.blockingDuration || 0,
        forcedStyleAndLayoutDuration: forced,
        scripts: (e.scripts || []).map((s) => ({
          sourceURL: s.sourceURL || '', sourceFunctionName: s.sourceFunctionName || '',
          sourceCharPosition: s.sourceCharPosition ?? -1, duration: s.duration || 0,
          invoker: s.invoker || '',
        })),
      });
    }
  });

  // ---- React commit accounting via a minimal DevTools global hook ----
  // A fiber that performed render work this commit has a numeric actualDuration.
  // We tally per-component commit counts and (subtree-inclusive) durations; the
  // commit count is the load-bearing "how often does this re-render" signal.
  const compName = (fiber) => {
    const t = fiber && fiber.type;
    if (!t) return null;
    if (typeof t === 'string') return null; // host element (div/span) — skip
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || null;
  };
  // A component "rendered" this commit iff React set the PerformedWork flag
  // (bit 0b1) on its fiber — i.e. its render function actually ran. This is
  // stable across React 18/19 and, unlike actualDuration, is populated in the
  // ordinary dev build (actualDuration only exists in the profiling build).
  const PERFORMED_WORK = 0b1;
  const walk = (fiber) => {
    if (!fiber) return;
    const flags = fiber.flags ?? fiber.effectTag ?? 0;
    if ((flags & PERFORMED_WORK) === PERFORMED_WORK) {
      const name = compName(fiber);
      if (name) {
        const dur = typeof fiber.actualDuration === 'number' ? fiber.actualDuration : 0;
        const r = store.renders[name] || (store.renders[name] = { component: name, commits: 0, totalDuration: 0, maxDuration: 0 });
        r.commits += 1; r.totalDuration += dur; if (dur > r.maxDuration) r.maxDuration = dur;
      }
    }
    walk(fiber.child); walk(fiber.sibling);
  };
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    let uid = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(), supportsFiber: true,
      inject(r) { const id = ++uid; this.renderers.set(id, r); return id; },
      onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
      onCommitFiberRoot(_id, root) {
        store.commits += 1;
        try { walk((root && root.current) || root); } catch (e) {}
      },
    };
  }

  store.__resetRenders = () => { store.renders = {}; store.commits = 0; };
})();
`

/**
 * Evaluated on demand to read a serializable snapshot with computed ratings.
 * Returns a shape compatible with the vitals/loaf/longTask/render types.
 */
export const READ_SNAPSHOT = /* js */ `
(() => {
  const s = window.__PERF_HUNT__ || {};
  const rate = (name, v) => {
    if (v == null) return 'good';
    const t = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], FCP: [1800, 3000], TTFB: [800, 1800] }[name];
    if (!t) return 'good';
    return v <= t[0] ? 'good' : v <= t[1] ? 'needs-improvement' : 'poor';
  };
  const vitals = [];
  if (s.lcp) vitals.push({ name: 'LCP', value: Math.round(s.lcp.value), rating: rate('LCP', s.lcp.value), attribution: s.lcp.target || s.lcp.url });
  if (s.inp) vitals.push({ name: 'INP', value: Math.round(s.inp), rating: rate('INP', s.inp), attribution: s.inpTarget });
  vitals.push({ name: 'CLS', value: Math.round(s.cls * 1000) / 1000, rating: rate('CLS', s.cls), attribution: s.clsTarget || undefined });
  if (s.fcp != null) vitals.push({ name: 'FCP', value: Math.round(s.fcp), rating: rate('FCP', s.fcp) });
  if (s.ttfb != null) vitals.push({ name: 'TTFB', value: Math.round(s.ttfb), rating: rate('TTFB', s.ttfb) });
  const renders = Object.values(s.renders || {})
    .map((r) => ({ ...r, totalDuration: Math.round(r.totalDuration * 100) / 100, maxDuration: Math.round(r.maxDuration * 100) / 100 }))
    .sort((a, b) => b.commits - a.commits);
  return {
    vitals,
    loaf: (s.loaf || []).filter((f) => f.duration >= 50),
    longTasks: s.longTasks || [],
    renders,
    commits: s.commits || 0,
  };
})();
`

/** Zeroes render counters so the next interaction can be measured in isolation. */
export const RESET_RENDERS = `window.__PERF_HUNT__ && window.__PERF_HUNT__.__resetRenders && window.__PERF_HUNT__.__resetRenders();`
