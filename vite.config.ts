/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/// <reference types="vitest/config" />
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'path'
import { defineConfig } from 'vite'
import { analyzer } from 'vite-bundle-analyzer'
import pkg from './package.json' with { type: 'json' }
const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon
const host = process.env.TAURI_DEV_HOST

// Import will happen eagerly, but the plugin is only activated when requested.

// Detect whether we should run the bundle analyzer. We look for either:
// 1. The ANALYZE environment variable explicitly set to "true" (e.g. `ANALYZE=true bun run build`)
// 2. The `analyze` npm/bun script being executed (process arguments include the word "analyze")
const shouldAnalyze = process.env.ANALYZE?.toLowerCase() === 'true' || process.argv.includes('analyze')

// Source maps are disabled by default so forks don't accidentally expose proprietary code.
// Enable with ENABLE_SOURCEMAP=true (e.g. in CI) to upload maps to PostHog for error tracking.
const sourcemap = process.env.ENABLE_SOURCEMAP?.toLowerCase() === 'true' ? 'hidden' : false

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    // Inject the package.json version so the client can send it as X-App-Version
    // and compare against the server-enforced minAppVersion.
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  build: {
    sourcemap,
    rolldownOptions: {
      external: ['bun:sqlite'],
      treeshake: {
        moduleSideEffects: [
          // @powersync/common doesn't declare "sideEffects" in its package.json, so every
          // module re-exported by its lib/index.js barrel is treated as potentially
          // side-effectful and eagerly retained in the entry chunk via @powersync/react's
          // static import. The modules are pure declarations (classes/consts only), so
          // mark them side-effect-free to let the unused sync-client machinery tree-shake
          // out of the entry and live only in the lazy PowerSync chunk.
          { test: /@powersync[\\/]common[\\/]lib/, sideEffects: false },
        ],
      },
      output: {
        // Distinct prefix for the entry chunk so size-limit can track the
        // FCP-blocking bytes separately from on-demand route chunks.
        entryFileNames: 'assets/entry-[hash].js',
      },
    },
  },
  plugins: [
    {
      name: 'copy-powersync-assets',
      buildStart() {
        execSync('powersync-web copy-assets --output public', { stdio: 'inherit' })
      },
    },
    tailwindcss(),
    react(),
    // Include the bundle analyzer plugin only when explicitly requested.
    ...(shouldAnalyze
      ? [
          analyzer({
            analyzerMode: 'static',
            openAnalyzer: false,
          }),
        ]
      : []),
    {
      name: 'configure-response-headers',
      configureServer: (server) => {
        server.middlewares.use((req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')

          // Set correct Content-Type for .well-known files (required for Universal Links / App Links)
          // Parse pathname to ignore query parameters
          const pathname = req.url?.split('?')[0]
          if (pathname === '/.well-known/apple-app-site-association') {
            res.setHeader('Content-Type', 'application/json')
          } else if (pathname === '/.well-known/assetlinks.json') {
            res.setHeader('Content-Type', 'application/json')
          }

          next()
        })
      },
    },
  ],
  resolve: {
    dedupe: ['@powersync/common', '@powersync/react', 'react'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
      // Exposes PowerSync internal lib path so our custom SharedWorker can extend
      // SharedSyncImplementation (not in public exports map).
      'powersync-web-internal': path.resolve(__dirname, 'node_modules/@powersync/web/lib/src'),
      // Resolve @powersync/common to its unbundled per-module build instead of the
      // single-file dist/bundle.mjs. A single ES module can only live in one chunk,
      // so the bundled build forces ALL of common retained anywhere in the app into
      // the entry chunk (entry code imports parseQuery/WatchedQueryListenerEvent via
      // @powersync/react + @powersync/tanstack-react-query). The per-module build
      // lets rolldown keep only those helpers in the entry and move the sync client
      // machinery into the lazy PowerSync chunk. Like powersync-web-internal above,
      // lib/ is an internal path — verify it still exists when upgrading the package.
      '@powersync/common': path.resolve(__dirname, 'node_modules/@powersync/common/lib/index.js'),
      // The in-browser Pi harness (lazy `@shared/agent-core` chunk) pulls Pi's Node
      // child-process helper, which imports `cross-spawn` (and, transitively, `which`).
      // Both evaluate `process.platform` at module scope, throwing
      // `ReferenceError: process is not defined` on import in the browser — before any
      // LLM call. The harness never resolves OS executables (bash runs through
      // BrowserExecutionEnv / just-bash over ZenFS), so these modules are dead weight
      // on the browser path; alias them to throw-on-call stubs (they load fine; only a
      // real call throws). A bare-specifier alias catches every copy regardless of
      // nesting and is honored by both the dev dep optimizer and the production build
      // (both Rolldown-based in Vite 8).
      'cross-spawn': path.resolve(__dirname, './shared/agent-core/browser-stubs/cross-spawn.ts'),
      which: path.resolve(__dirname, './shared/agent-core/browser-stubs/which.ts'),
      // Pi is a Node CLI: a few of its modules import these builtins at module scope
      // (`config.js` → url+path, the clipboard helper → url+module+path). Vite's
      // default `browser-external:*` leaves the named exports undefined, so importing
      // Pi throws (e.g. "fileURLToPath is not a function"). Map them to browser shims:
      // `path` to the battle-tested `path-browserify` (its functions also run at
      // browser runtime when the read/write/edit tools resolve paths), and `url`/
      // `module` to tiny stubs that satisfy the module-scope reads. (The bare
      // `process` global is handled separately in shared/agent-core/index.ts.)
      url: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-url.ts'),
      'node:url': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-url.ts'),
      module: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-module.ts'),
      'node:module': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-module.ts'),
      path: 'path-browserify',
      'node:path': 'path-browserify',
      // Pi also touches `fs`/`os` (config/package detection) and `crypto`
      // (runtime id generation) — Vite's `browser-external:*` leaves these
      // undefined. `crypto` delegates to the browser's native Web Crypto (real
      // `randomUUID`/`randomBytes`); `fs`/`os` present an empty filesystem so Pi
      // falls back to defaults (the harness's real I/O goes through ZenFS, never
      // these). No app code imports these in the browser — only Pi does.
      // NOTE: `fs/promises` MUST precede `fs` — a string alias matches `find` and
      // `find/*`, so `fs` would otherwise swallow `fs/promises` → `node-fs.ts/promises`.
      'fs/promises': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-fs-promises.ts'),
      'node:fs/promises': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-fs-promises.ts'),
      // node-fs is CommonJS (not ESM) so `graceful-fs` can monkey-patch it in place.
      fs: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-fs.cjs'),
      'node:fs': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-fs.cjs'),
      // `graceful-fs` calls `require('constants').hasOwnProperty(...)`; the
      // browser-external proxy's `hasOwnProperty` isn't callable, so give it a real object.
      constants: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-constants.cjs'),
      'node:constants': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-constants.cjs'),
      os: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-os.ts'),
      'node:os': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-os.ts'),
      crypto: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-crypto.ts'),
      'node:crypto': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-crypto.ts'),
      // pi-tui extends `EventEmitter`; map `events` to its browser polyfill (explicit
      // file path so the alias can't resolve back to the externalized Node builtin).
      events: path.resolve(__dirname, './node_modules/events/events.js'),
      'node:events': path.resolve(__dirname, './node_modules/events/events.js'),
      // `undici` (Pi's Node HTTP dispatcher) extends Node stream/net/tls classes at
      // module scope and is never used in the browser (model calls go through the
      // injected proxy fetch). Stub it so its Node-only graph stays out of the bundle.
      undici: path.resolve(__dirname, './shared/agent-core/browser-stubs/undici.ts'),
    },
    conditions: ['browser'],
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
    fs: {
      strict: true,
      allow: [
        path.resolve(__dirname, 'src'),
        path.resolve(__dirname, 'shared'),
        path.resolve(__dirname, 'public'),
        path.resolve(__dirname, 'node_modules'),
        path.resolve(__dirname, 'dist-isolation'),
        path.resolve(__dirname, '.storybook'),
        // Vite's HTML middleware checks checkLoadingAccess() for index.html
        path.resolve(__dirname, 'index.html'),
      ],
    },
  },
  optimizeDeps: {
    exclude: ['@journeyapps/wa-sqlite', '@powersync/web'],
  },
  worker: {
    format: 'es',
  },
  test: {
    projects: [
      {
        extends: true,
        plugins: [
          // The plugin will run tests for the stories defined in your Storybook config
          // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
          storybookTest({
            configDir: path.join(dirname, '.storybook'),
          }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            headless: true,
            provider: 'playwright',
            instances: [
              {
                browser: 'chromium',
              },
            ],
          },
          setupFiles: ['.storybook/vitest.setup.ts'],
        },
      },
    ],
  },
})
