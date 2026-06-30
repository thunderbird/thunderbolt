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
