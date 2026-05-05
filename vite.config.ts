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
import { defineConfig, type Plugin } from 'vite'
import { analyzer } from 'vite-bundle-analyzer'
const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url))

/**
 * Print a yellow security-reminder banner once when the dev server starts.
 * Constant (not detection-driven) — the actual detection happens in the
 * browser DevTools console once the SPA fetches /v1/api/config from the
 * backend. This banner just makes sure the dev who ran `bun run dev` is
 * aware before they get to that point. Suppressed with
 * DANGEROUSLY_ALLOW_DEFAULT_CREDS=true.
 *
 * The canonical list of defaults + override commands lives at
 * deploy/README.md#default-credentials and shared/insecure-defaults.ts.
 * The banner here is intentionally self-contained (no cross-project
 * import) so vite.config.ts stays in the Node tsconfig project without
 * pulling shared/ across the project-reference boundary.
 */
const DOCS_URL = 'https://github.com/thunderbird/thunderbolt/blob/main/deploy/README.md#default-credentials'
const insecureDefaultsReminderPlugin = (): Plugin => ({
  name: 'thunderbolt-insecure-defaults-reminder',
  apply: 'serve',
  configureServer(server) {
    if (process.env.DANGEROUSLY_ALLOW_DEFAULT_CREDS?.toLowerCase() === 'true') return
    server.httpServer?.once('listening', () => {
      const useColor = Boolean(process.stdout.isTTY)
      const Y = useColor ? '\x1b[43;1;30m' : ''
      const R = useColor ? '\x1b[0m' : ''
      const W = 78
      const pad = (s: string): string => s + ' '.repeat(Math.max(0, W - s.length))
      const line = (s: string): string => `${Y}║ ${pad(s)} ║${R}`
      const out =
        '\n' +
        `${Y}╔${'═'.repeat(W + 2)}╗${R}\n` +
        line('') +
        '\n' +
        line('  ⚠   Thunderbolt frontend dev server — security reminder') +
        '\n' +
        line('') +
        '\n' +
        line('  If your backend is using default credentials, the browser') +
        '\n' +
        line('  DevTools console will print a red banner naming each one.') +
        '\n' +
        line('  Rotate them before pointing this at a real deployment.') +
        '\n' +
        line('') +
        '\n' +
        line(`  ${DOCS_URL}`) +
        '\n' +
        line('') +
        '\n' +
        line('  Suppress: DANGEROUSLY_ALLOW_DEFAULT_CREDS=true') +
        '\n' +
        line('') +
        '\n' +
        `${Y}╚${'═'.repeat(W + 2)}╝${R}\n\n`
      process.stdout.write(out)
    })
  },
})

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
  build: {
    sourcemap,
    rollupOptions: {
      external: ['bun:sqlite'],
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
    insecureDefaultsReminderPlugin(),
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
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
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
