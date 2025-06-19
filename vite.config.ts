import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { defineConfig } from 'vite'
import { analyzer } from 'vite-bundle-analyzer'
import { bundleMigrations } from './src/db/bundle-migrations'

const host = process.env.TAURI_DEV_HOST

// Import will happen eagerly, but the plugin is only activated when requested.

// Detect whether we should run the bundle analyzer. We look for either:
// 1. The ANALYZE environment variable explicitly set to "true" (e.g. `ANALYZE=true bun run build`)
// 2. The `analyze` npm/bun script being executed (process arguments include the word "analyze")
const shouldAnalyze = process.env.ANALYZE?.toLowerCase() === 'true' || process.argv.includes('analyze')

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    {
      name: 'bundle-migrations',
      async buildStart() {
        bundleMigrations({
          migrationsDir: path.resolve(__dirname, 'src/drizzle'),
          outputFile: path.resolve(__dirname, 'src/drizzle/_migrations.ts'),
        })
      },
    },
    {
      name: 'build-flower-intelligence',
      async buildStart() {
        const publicFlowerFile = path.resolve(__dirname, 'public/flower/intelligence/ts/dist/flowerintelligence.bundled.es.js')

        // Skip if file already exists in public
        if (fs.existsSync(publicFlowerFile)) {
          console.log('✅ Flower Intelligence already exists in public directory, skipping build...')
          return
        }

        console.log('🌸 Building Flower Intelligence...')

        const scriptPath = path.resolve(__dirname, 'scripts', 'build-flower.sh')
        const execCmd = process.platform === 'win32' ? `bash ${scriptPath.replace(/\\/g, '/')}` : scriptPath

        execSync(execCmd, { stdio: 'inherit' })

        const flowerDistFile = path.resolve(__dirname, 'flower/intelligence/ts/dist/bundled/flowerintelligence.bundled.es.js')

        // Create public directory structure
        const publicFlowerDir = path.resolve(__dirname, 'public/flower/intelligence/ts/dist')
        fs.mkdirSync(publicFlowerDir, { recursive: true })

        // Copy the bundled file to public directory (for browser usage)
        if (fs.existsSync(flowerDistFile)) {
          fs.copyFileSync(flowerDistFile, publicFlowerFile)
          console.log('✅ Flower Intelligence built and copied to public directory')
        } else {
          throw new Error('Flower Intelligence build failed - flowerintelligence.bundled.es.js not found')
        }
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
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          next()
        })
      },
    },
  ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
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
  },
  optimizeDeps: {
    exclude: ['sqlocal'],
  },
  worker: {
    format: 'es',
  },
})
