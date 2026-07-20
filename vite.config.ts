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
    // react-dismissable-layer must be a single module instance: it tracks
    // open layers in module-scope state to know when to restore the body's
    // pointer-events. Bun nests a second copy under @radix-ui/react-menu;
    // with two instances, closing a dialog opened from a dropdown menu item
    // restores `pointer-events: none` and the whole app stops being
    // clickable. The package.json direct dependency on
    // @radix-ui/react-dismissable-layer exists solely to hoist one copy for
    // this dedupe — it is load-bearing even though nothing imports it.
    // react-dialog is deduped for the same reason: bun nests a stale copy
    // under `cmdk`, and two dialog module instances would split the same
    // module-scope layer bookkeeping.
    dedupe: [
      '@powersync/common',
      '@powersync/react',
      'react',
      '@radix-ui/react-dismissable-layer',
      '@radix-ui/react-dialog',
    ],
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
      // ---- In-browser Pi harness (lazy `@shared/agent-core` chunk) Node shims ----
      // The harness runs `@earendil-works/pi-agent-core` + `pi-ai` + `just-bash` +
      // ZenFS in the browser. The four coding tools are now plain `AgentTool`s over
      // BrowserExecutionEnv (see `shared/agent-core/coding-tools`), so the
      // `@earendil-works/pi-coding-agent` CLI — and its cross-spawn / which / undici /
      // graceful-fs / pi-tui cascade — is no longer imported. Only a small residual of
      // Node-builtin shims remains, for code still on the app path:
      //
      // `just-bash`'s browser bundle evaluates `createRequire(import.meta.url)` at
      // module scope, so `module` must resolve to a shim that exposes `createRequire`.
      module: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-module.ts'),
      'node:module': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-module.ts'),
      // `path` runs at browser runtime; use the battle-tested polyfill.
      path: 'path-browserify',
      'node:path': 'path-browserify',
      // `crypto` delegates to the browser's native Web Crypto (real `randomUUID` /
      // `randomBytes`); `fs`/`fs/promises` present an empty filesystem (the harness's
      // real I/O goes through ZenFS). All are reached only lazily — via the
      // `createRequire` shim above, pi-ai's `process.versions.bun`-guarded
      // `require("node:fs")` fallback, or optional SDK code paths — never at module
      // scope. NOTE: `fs/promises` MUST precede `fs` — a string alias also matches the
      // `fs/promises` subpath, so `fs` would otherwise swallow it.
      'fs/promises': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-fs-promises.ts'),
      'node:fs/promises': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-fs-promises.ts'),
      fs: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-fs.cjs'),
      'node:fs': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-fs.cjs'),
      crypto: path.resolve(__dirname, './shared/agent-core/browser-stubs/node-crypto.ts'),
      'node:crypto': path.resolve(__dirname, './shared/agent-core/browser-stubs/node-crypto.ts'),
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
    // Bind an explicit loopback address rather than `false`. Vite maps `false`
    // to the hostname string "localhost", which Node resolves to a SINGLE,
    // nondeterministic address family (127.0.0.1 or ::1) per listen() call. A
    // `.env` change restarts the dev server, which re-resolves "localhost" and
    // can FLIP families — leaving nothing bound on the address the browser (or
    // an OrbStack/VM port-forward) is actually connecting to, so localhost:1420
    // goes dead until the process is killed. Pinning 127.0.0.1 keeps the bind
    // deterministic and loopback-only across restarts.
    host: host || '127.0.0.1',
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
