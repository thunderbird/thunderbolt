import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig, type Plugin } from 'vite'

/** Inject <link rel="preload"> for latin woff2 font files so the browser fetches them immediately. */
const fontPreload = (): Plugin => ({
  name: 'font-preload',
  transformIndexHtml: {
    order: 'post',
    handler(html, { bundle }) {
      if (!bundle) return html
      const fontFiles = Object.keys(bundle).filter(
        (f) => f.endsWith('.woff2') && f.includes('-latin-') && !f.includes('-ext-'),
      )
      const tags = fontFiles.map(
        (f) => `<link rel="preload" href="/${f}" as="font" type="font/woff2" crossorigin>`,
      )
      return html.replace('</head>', `${tags.join('\n')}\n</head>`)
    },
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), fontPreload()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    fs: {
      strict: true,
      allow: [
        path.resolve(__dirname, 'src'),
        path.resolve(__dirname, 'public'),
        path.resolve(__dirname, 'node_modules'),
        path.resolve(__dirname, 'index.html'),
      ],
    },
  },
})
