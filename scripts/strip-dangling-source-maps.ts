/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import path from 'node:path'
import type { Plugin } from 'vite'

const sourceMapComment = /(?<=^|\n)\/\/# sourceMappingURL=(\S+)\s*$/

/**
 * A script asset's source without a trailing `sourceMappingURL` comment whose map is not in the bundle, or null
 * when there is nothing to strip. `?url` imports copy a library file verbatim under a hashed name, so the comment
 * it ships with points at a map the build never emits.
 */
export const stripDanglingSourceMapComment = (fileName: string, source: string, bundleFileNames: Set<string>) => {
  const match = source.match(sourceMapComment)
  if (!match || match[1].startsWith('data:')) {
    return null
  }
  const mapFileName = path.posix.join(path.posix.dirname(fileName), match[1])
  return bundleFileNames.has(mapFileName) ? null : source.slice(0, match.index)
}

/** Drops `sourceMappingURL` comments that copied script assets carry for maps the build does not emit. */
export const stripDanglingSourceMapsPlugin = (): Plugin => ({
  name: 'strip-dangling-source-maps',
  apply: 'build',
  generateBundle(_options, bundle) {
    const fileNames = new Set(Object.keys(bundle))
    for (const file of Object.values(bundle)) {
      if (file.type !== 'asset' || !/\.[cm]?js$/.test(file.fileName)) {
        continue
      }
      const source = typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source)
      const stripped = stripDanglingSourceMapComment(file.fileName, source, fileNames)
      if (stripped !== null) {
        file.source = stripped
      }
    }
  },
})
