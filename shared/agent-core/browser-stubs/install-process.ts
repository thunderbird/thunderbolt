/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Installs the Node globals (`process`, `global`) the lazily-loaded Pi engine
 * expects but the browser lacks.
 *
 * Why this exists: Pi's runtime (`@earendil-works/pi-ai`) and the Anthropic SDK
 * still read the bare `process` global to detect their environment —
 * `process.versions?.node`/`process.env.*` in provider/auth helpers — and some
 * dependency code references the bare `global` object, so loading them throws
 * `ReferenceError: process is not defined` / `global is not defined` in the
 * browser. Because these are bare globals (not `import … from 'process'`), a
 * module alias can't reach them; the globals must exist when those modules
 * evaluate. (The pi-coding-agent CLI modules that previously needed this — its
 * `config.js`/`timings.js`/clipboard helper — are no longer on the app path.)
 *
 * Why a side-effecting import rather than a runtime shim: ES module imports are
 * hoisted and evaluated in source order, so a `globalThis.process = …` assignment
 * placed inside a consumer runs *after* the hoisted Pi import has already thrown.
 * This module performs the assignment at its own module scope and is imported
 * first by `shared/agent-core/index.ts` (the lazy chunk's entry), so the global is
 * in place before any Pi module evaluates — and, living only in that chunk, it
 * never touches the entry bundle.
 *
 * The harness never executes OS processes (bash runs through BrowserExecutionEnv),
 * so this shim only has to satisfy the module-scope reads above and stay inert.
 */

/** Minimal browser stand-in for Node's `process` — just the surface Pi reads. */
const browserProcess = {
  /** Pi treats truthy `browser` as "take the browser code path" where it checks. */
  browser: true,
  env: {} as Record<string, string | undefined>,
  platform: 'browser',
  arch: 'wasm',
  version: '',
  versions: {} as Record<string, string | undefined>,
  argv: [] as string[],
  execPath: '/pi',
  cwd: () => '/',
  chdir: () => {},
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    queueMicrotask(() => callback(...args))
  },
  // Some libraries register lifecycle listeners (`process.on('exit', …)`); accept
  // and ignore them so the chainable API stays intact.
  on: () => browserProcess,
  once: () => browserProcess,
  off: () => browserProcess,
  removeListener: () => browserProcess,
  emit: () => false,
}

const scope = globalThis as unknown as { process?: unknown; global?: unknown }
scope.process ??= browserProcess
// Some Pi/dependency code references the bare Node `global` object; in the browser
// it is the same as `globalThis`.
scope.global ??= globalThis
