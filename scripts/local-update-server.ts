/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Local update server for testing Tauri updater flow.
 *
 * Serves update manifests and bundles from the release build output.
 * Point the old build's updater endpoint to http://localhost:8888/update/{{target}}-{{arch}}/{{current_version}}
 *
 * Usage:
 *   1. Build the new version: TAURI_SIGNING_PRIVATE_KEY=~/.tauri/test-update.key bun tauri build
 *   2. Start this server: bun run scripts/local-update-server.ts
 *   3. Open the old build and trigger the update
 */

const BUNDLE_DIR = new URL('../src-tauri/target/release/bundle', import.meta.url).pathname
const PORT = 8888

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    console.log(`${req.method} ${url.pathname}`)

    // Tauri updater hits: GET /update/{target}-{arch}/{current_version}
    // It expects a JSON response with the update info, or 204 if no update
    if (url.pathname.startsWith('/update/')) {
      const parts = url.pathname.split('/')
      const platform = parts[2] // e.g. "darwin-aarch64"
      const currentVersion = parts[3]

      // Find the .tar.gz update bundle and its .sig file
      const glob = new Bun.Glob('macos/*.tar.gz')
      const bundles = Array.from(glob.scanSync(BUNDLE_DIR))

      if (bundles.length === 0) {
        console.error('No update bundles found in', BUNDLE_DIR + '/macos/')
        return new Response('No bundles found', { status: 500 })
      }

      const bundleName = bundles[0]
      const bundlePath = `${BUNDLE_DIR}/${bundleName}`
      const sigPath = `${bundlePath}.sig`

      // Read signature
      let signature: string
      try {
        signature = await Bun.file(sigPath).text()
      } catch {
        console.error('Signature file not found:', sigPath)
        return new Response('Signature not found', { status: 500 })
      }

      // Read version from tauri.conf.json
      const confPath = new URL('../src-tauri/tauri.conf.json', import.meta.url).pathname
      const conf = await Bun.file(confPath).json()
      const newVersion = conf.version

      console.log(`Current: ${currentVersion}, Available: ${newVersion}, Bundle: ${bundleName}`)

      if (currentVersion === newVersion) {
        return new Response(null, { status: 204 })
      }

      const manifest = {
        version: newVersion,
        notes: `Update to ${newVersion}`,
        pub_date: new Date().toISOString(),
        url: `http://localhost:${PORT}/bundle/${bundleName}`,
        signature,
      }

      console.log('Serving update manifest:', JSON.stringify(manifest, null, 2))
      return Response.json(manifest)
    }

    // Serve the actual bundle file
    if (url.pathname.startsWith('/bundle/')) {
      const relativePath = url.pathname.substring('/bundle/'.length)
      if (relativePath.includes('..')) {
        console.error(`Path traversal attempt blocked: ${relativePath}`)
        return new Response('Forbidden', { status: 403 })
      }
      const filePath = `${BUNDLE_DIR}/${relativePath}`
      const file = Bun.file(filePath)

      if (!(await file.exists())) {
        console.error('Bundle not found:', filePath)
        return new Response('Not found', { status: 404 })
      }

      console.log('Serving bundle:', filePath, `(${(file.size / 1024 / 1024).toFixed(1)}MB)`)
      return new Response(file, {
        headers: { 'Content-Type': 'application/gzip' },
      })
    }

    return new Response('Not found', { status: 404 })
  },
})

console.log(`Local update server running at http://localhost:${PORT}`)
console.log(`Bundle dir: ${BUNDLE_DIR}`)
console.log(`\nWaiting for update requests...`)
