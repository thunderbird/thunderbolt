#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * License Header Tool
 *
 * Adds MPL notices to community source and UNLICENSED/TBD notices to admin/.
 * Idempotent — running it twice is a no-op.
 *
 * Modes:
 *   bun scripts/license-headers.ts                  Add header to any missing tracked source files
 *   bun scripts/license-headers.ts --check          Verify only, exit 1 if any are missing (CI mode)
 *   bun scripts/license-headers.ts <path> [<path>]  Operate on specific files (used by lint-staged)
 *
 * Wired up in two places:
 *   - .lintstagedrc → runs on staged source files in pre-commit hook
 *   - package.json `license:check` → wired into `bun run check` for CI
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..')

const mplHeaderLines = [
  'This Source Code Form is subject to the terms of the Mozilla Public',
  'License, v. 2.0. If a copy of the MPL was not distributed with this',
  'file, You can obtain one at http://mozilla.org/MPL/2.0/.',
]

const adminHeaderLines = [
  'UNLICENSED — license TBD. This file is not licensed under MPL-2.0.',
  'All rights reserved. See admin/LICENSE.',
  'Enterprise support and licensing: contact info@thunderbolt.io.',
]

/** Select a notice by repository-relative scope, including absolute hook paths. */
export const headerLinesForPath = (path: string): string[] =>
  relative(repoRoot, resolve(repoRoot, path)).split(sep).join('/').startsWith('admin/')
    ? adminHeaderLines
    : mplHeaderLines

type CommentStyle = 'block' | 'hash' | 'dash' | 'html' | 'astro'

const styleByExt: Record<string, CommentStyle> = {
  '.ts': 'block',
  '.tsx': 'block',
  '.js': 'block',
  '.jsx': 'block',
  '.cjs': 'block',
  '.mjs': 'block',
  '.css': 'block',
  '.scss': 'block',
  '.rs': 'block',
  '.kt': 'block',
  '.kts': 'block',
  '.sh': 'hash',
  '.sql': 'dash',
  '.html': 'html',
  '.astro': 'astro',
}

const skipPathPatterns: RegExp[] = [
  /(^|\/)src-tauri\/gen\//,
  /(^|\/)drizzle\/meta\//,
  /(^|\/)dist(-[^/]+)?\//,
  /(^|\/)node_modules\//,
  // Generated wasm-bindgen glue for the iroh ACP client (build artifact).
  /(^|\/)src\/acp\/iroh\/pkg\//,
  // Lingui-generated email catalogs (`bun run i18n:extract` owns these).
  /(^|\/)backend\/src\/emails\/locales\//,
  /(^|\/)crates\/[^/]+\/target\//,
  /\.gen\.[a-z]+$/i,
]

const directiveRe = /^\s*(['"])use (client|server|strict)\1\s*;?\s*$/

const renderHeader = (style: CommentStyle, headerLines: string[]): string => {
  switch (style) {
    case 'block':
      return `/* ${headerLines[0]}\n * ${headerLines[1]}\n * ${headerLines[2]} */\n`
    case 'hash':
      return headerLines.map((l) => `# ${l}`).join('\n') + '\n'
    case 'dash':
      return headerLines.map((l) => `-- ${l}`).join('\n') + '\n'
    case 'html':
      return `<!-- ${headerLines[0]}\n   - ${headerLines[1]}\n   - ${headerLines[2]} -->\n`
    case 'astro':
      // Inserted inside frontmatter as // comments — caller handles framing
      return headerLines.map((l) => `// ${l}`).join('\n')
  }
}

/** Inspect only the leading notice, not license names quoted inside source/tests. */
export const headerStatus = (content: string, path: string): 'valid' | 'missing' | 'conflict' => {
  const leading = content
    .replace(/^#![^\n]*\n/, '')
    .replace(/^\s*(['"])use (client|server|strict)\1\s*;?\s*/, '')
    .trimStart()
    .replace(/^---\r?\n/, '')
  const comment = leading.match(/^(?:\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?:(?:#|--|\/\/)[^\n]*(?:\n|$))+)/)?.[0] ?? ''
  const expected = headerLinesForPath(path)
  const hasMpl = comment.includes('mozilla.org/MPL') || comment.includes('SPDX-License-Identifier: MPL-2.0')
  const hasAdmin = comment.includes('UNLICENSED') || comment.includes('license TBD')
  if ((expected === adminHeaderLines && hasMpl) || (expected === mplHeaderLines && hasAdmin)) {
    return 'conflict'
  }
  if (expected.every((line) => comment.includes(line)) || (expected === mplHeaderLines && hasMpl)) {
    return 'valid'
  }
  return /SPDX-License-Identifier|UNLICENSED|Mozilla Public License/.test(comment) ? 'conflict' : 'missing'
}

const isInScope = (path: string): boolean => {
  if (skipPathPatterns.some((re) => re.test(path))) {
    return false
  }
  return styleByExt[extname(path).toLowerCase()] !== undefined
}

/** Add the scoped notice while preserving shebangs and source directives. */
export const applyHeader = (content: string, path: string): string => {
  const status = headerStatus(content, path)
  if (status === 'valid') {
    return content
  }
  if (status === 'conflict') {
    throw new Error('Conflicting source notice: ' + path)
  }

  const ext = extname(path).toLowerCase()
  const style = styleByExt[ext]

  if (style === 'astro') {
    return applyAstroHeader(content, headerLinesForPath(path))
  }

  const header = renderHeader(style, headerLinesForPath(path))
  const lines = content.split('\n')
  let insertAt = 0

  // Preserve shebang on line 1
  if (lines[0]?.startsWith('#!')) {
    insertAt = 1
  }

  // Preserve a leading directive ("use client"/"use server"/"use strict")
  if (
    (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.cjs' || ext === '.mjs') &&
    directiveRe.test(lines[insertAt] ?? '')
  ) {
    insertAt++
  }

  const before = lines.slice(0, insertAt)
  const after = lines.slice(insertAt)

  const trailingBlank = after[0] === '' ? '' : '\n'
  const leadingNewlineForHeader = before.length > 0 ? '\n' : ''

  return (
    (before.length ? before.join('\n') + '\n' : '') +
    leadingNewlineForHeader +
    header +
    trailingBlank +
    after.join('\n')
  )
}

const applyAstroHeader = (content: string, linesForPath: string[]): string => {
  const lines = content.split('\n')
  if (lines[0] === '---') {
    return ['---', renderHeader('astro', linesForPath), ...lines.slice(1)].join('\n')
  }
  // No frontmatter — fall back to an HTML comment at the top
  return renderHeader('html', linesForPath) + '\n' + content
}

const listTrackedFiles = (): string[] =>
  execSync('git ls-files --cached --others --exclude-standard', { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

const main = () => {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const explicitPaths = args.filter((a) => !a.startsWith('--'))

  const candidates = (explicitPaths.length > 0 ? explicitPaths : listTrackedFiles()).filter(isInScope)

  const missing: string[] = []
  let touched = 0

  for (const relPath of candidates) {
    const absPath = resolve(repoRoot, relPath)
    let content: string
    try {
      content = readFileSync(absPath, 'utf8')
    } catch {
      continue
    }

    const status = headerStatus(content, relPath)
    if (status === 'valid') {
      continue
    }

    if (checkOnly || status === 'conflict') {
      missing.push(status === 'conflict' ? relPath + ' (conflicting notice; review required)' : relPath)
      continue
    }

    writeFileSync(absPath, applyHeader(content, relPath))
    touched++
  }

  if (checkOnly || missing.length > 0) {
    if (missing.length === 0) {
      console.log(`License header check passed (${candidates.length} files).`)
      process.exit(0)
    }
    console.error(`Missing or conflicting scoped license header in ${missing.length} file(s):`)
    for (const p of missing) {
      console.error(`  ${p}`)
    }
    console.error('\nRun `bun run license:fix` to add headers automatically.')
    process.exit(1)
  }

  if (touched === 0) {
    console.log(`License headers up to date (${candidates.length} files checked).`)
  } else {
    console.log(`Added scoped license header to ${touched} file(s).`)
  }
}

if (import.meta.main) {
  main()
}
