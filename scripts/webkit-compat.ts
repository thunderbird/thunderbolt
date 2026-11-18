/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'
import { installWebKitOwnPropertyCompat } from '../src/lib/webkit-own-property'

// A classic script must finish before module dependencies can capture the native intrinsic.
export const webkitCompatScript = `;(() => { 'use strict'; (${installWebKitOwnPropertyCompat.toString()})(typeof navigator === 'undefined' ? '' : navigator.userAgent); })();\n`

const compatHash = createHash('sha256').update(webkitCompatScript).digest('hex').slice(0, 12)

/** Include the added bootstrap in the cache key for JavaScript emitted as a raw asset. */
export const webkitCompatAssetFileNames = ({ names }: { names: string[] }): string =>
  names.some((name) => /\.(?:js|mjs)$/.test(name))
    ? `assets/[name]-[hash]-${compatHash}[extname]`
    : 'assets/[name]-[hash][extname]'

/** Prefix standalone worker assets too, including PowerSync's copied workers and PDF.js. */
export const addWebKitCompatToAsset = (file: string, content: Buffer): Buffer => {
  if (/\.(?:js|mjs)$/.test(file)) {
    return Buffer.concat([Buffer.from(webkitCompatScript), content])
  }
  if (/\.(?:js|mjs)\.map$/.test(file)) {
    const map = JSON.parse(content.toString()) as { mappings: string }
    map.mappings = ';'.repeat(webkitCompatScript.split('\n').length - 1) + map.mappings
    return Buffer.from(JSON.stringify(map))
  }
  return content
}

/** Install before page modules, and cover worker files emitted as assets instead of bundled entries. */
export const webkitCompatPlugin = (): Plugin => ({
  name: 'webkit-own-property-compat',
  transformIndexHtml: {
    order: 'pre',
    handler: () => [{ tag: 'script', children: webkitCompatScript, injectTo: 'head-prepend' }],
  },
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type !== 'asset') {
        continue
      }
      if (!/\.(?:js|mjs)$/.test(output.fileName)) {
        continue
      }
      output.source = addWebKitCompatToAsset(output.fileName, Buffer.from(output.source))
      const map = bundle[`${output.fileName}.map`]
      if (map?.type === 'asset') {
        map.source = addWebKitCompatToAsset(map.fileName, Buffer.from(map.source))
      }
    }
  },
})

/**
 * Dynamically imported modules whose script chunks are not preloaded, by chunk name: the module's file name, or its
 * folder's for an `index`. Safari keeps every module fetch that failed for as long as the page lives, a module preload
 * included, and every later import of that chunk fails with it. So these imports start only once the app's server
 * answers (`importWhenReachable` in src/content-view/retryable-lazy.ts), and their chunks are not preloaded either: a
 * preload runs beside the import and can fail on its own, for example while the viewer's stylesheet is still loading.
 * The card thumbnails and the DOCX and PPTX renderers are here because they load chunks the viewers need.
 */
export const importsWithoutPreload = [
  'pdf-sidebar-viewer',
  'xlsx-preview',
  'pdf-thumbnail',
  'docx-snapshot',
  'pptx-snapshot',
]

const chunksWithoutPreload = new RegExp(`/(?:${importsWithoutPreload.join('|')})-[^/]*\\.js$`)

/** `build.modulePreload.resolveDependencies`: no script preloads for those chunks, the usual ones for the rest. */
export const resolvePreloadDependencies = (filename: string, deps: string[]): string[] =>
  chunksWithoutPreload.test(filename) ? [] : deps
