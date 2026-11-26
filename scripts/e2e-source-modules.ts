/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

const outputDir = 'e2e-source'
const moduleUrlPattern = /'(\/(?:src|node_modules)\/[^'\s]+\.(?:tsx?|m?js))'/g

/**
 * The app modules e2e specs import inside the page by dev-server URL (`import('/src/db/database.ts')`), found by
 * scanning `e2e/` for quoted `/src/...` and `/node_modules/...` paths that exist.
 */
export const findE2eSourceModules = (root: string): string[] => {
  const e2eDir = path.join(root, 'e2e')
  const urls = readdirSync(e2eDir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.includes('node_modules'))
    .flatMap((file) => [...readFileSync(path.join(e2eDir, file), 'utf8').matchAll(moduleUrlPattern)].map((m) => m[1]))
    .filter((url) => existsSync(path.join(root, url)))
  return [...new Set(urls)].sort()
}

/** Build inputs that emit each module as its own entry, sharing the app's chunks and so its module instances. */
export const e2eSourceEntries = (root: string, urls: string[]): Record<string, string> =>
  Object.fromEntries(urls.map((url) => [`${outputDir}${url}`, path.join(root, url)]))

/** Whether a chunk is one of the entries from `e2eSourceEntries`. */
export const isE2eSourceEntry = (name: string) => name.startsWith(`${outputDir}/`)

/**
 * Answers each dev-server URL the specs import with a re-export of its built entry. A re-export rather than a URL
 * rewrite, because the browser keys modules by URL: serving the entry under a second URL would evaluate it twice.
 */
export const e2eSourceModulesPlugin = (urls: string[]): Plugin => ({
  name: 'e2e-source-modules',
  configurePreviewServer: (server) => {
    server.middlewares.use((req, res, next) => {
      const pathname = req.url?.split('?')[0]
      if (!pathname || !urls.includes(pathname)) {
        return next()
      }
      res.setHeader('Content-Type', 'text/javascript')
      res.end(`export * from '/${outputDir}${pathname}.js'\n`)
    })
  },
})
