#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * License Header Tool
 *
 * Adds the MPL 2.0 short-form header to source files that don't have it.
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
import { extname, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')

const HEADER_LINES = [
  'This Source Code Form is subject to the terms of the Mozilla Public',
  'License, v. 2.0. If a copy of the MPL was not distributed with this',
  'file, You can obtain one at http://mozilla.org/MPL/2.0/.',
]

type CommentStyle = 'block' | 'hash' | 'dash' | 'html' | 'astro'

const STYLE_BY_EXT: Record<string, CommentStyle> = {
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

const SKIP_PATH_PATTERNS: RegExp[] = [
  /(^|\/)src-tauri\/gen\//,
  /(^|\/)drizzle\/meta\//,
  /(^|\/)dist(-[^/]+)?\//,
  /(^|\/)node_modules\//,
  /\.gen\.[a-z]+$/i,
]

const DIRECTIVE_RE = /^\s*(['"])use (client|server|strict)\1\s*;?\s*$/

const renderHeader = (style: CommentStyle): string => {
  switch (style) {
    case 'block':
      return `/* ${HEADER_LINES[0]}\n * ${HEADER_LINES[1]}\n * ${HEADER_LINES[2]} */\n`
    case 'hash':
      return HEADER_LINES.map((l) => `# ${l}`).join('\n') + '\n'
    case 'dash':
      return HEADER_LINES.map((l) => `-- ${l}`).join('\n') + '\n'
    case 'html':
      return `<!-- ${HEADER_LINES[0]}\n   - ${HEADER_LINES[1]}\n   - ${HEADER_LINES[2]} -->\n`
    case 'astro':
      // Inserted inside frontmatter as // comments — caller handles framing
      return HEADER_LINES.map((l) => `// ${l}`).join('\n')
  }
}

const hasHeader = (content: string): boolean =>
  content.includes('Mozilla Public License') || content.includes('mozilla.org/MPL')

const isInScope = (path: string): boolean => {
  if (SKIP_PATH_PATTERNS.some((re) => re.test(path))) return false
  return STYLE_BY_EXT[extname(path).toLowerCase()] !== undefined
}

const applyHeader = (content: string, path: string): string => {
  const ext = extname(path).toLowerCase()
  const style = STYLE_BY_EXT[ext]

  if (style === 'astro') return applyAstroHeader(content)

  const header = renderHeader(style)
  const lines = content.split('\n')
  let insertAt = 0

  // Preserve shebang on line 1
  if (lines[0]?.startsWith('#!')) insertAt = 1

  // Preserve a leading directive ("use client"/"use server"/"use strict")
  if (
    (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.cjs' || ext === '.mjs') &&
    DIRECTIVE_RE.test(lines[insertAt] ?? '')
  ) {
    insertAt++
  }

  const before = lines.slice(0, insertAt)
  const after = lines.slice(insertAt)

  const trailingBlank = after[0] === '' ? '' : '\n'
  const leadingNewlineForHeader = before.length > 0 ? '\n' : ''

  return (
    (before.length ? before.join('\n') + '\n' : '') + leadingNewlineForHeader + header + trailingBlank + after.join('\n')
  )
}

const applyAstroHeader = (content: string): string => {
  const lines = content.split('\n')
  if (lines[0] === '---') {
    return ['---', renderHeader('astro'), ...lines.slice(1)].join('\n')
  }
  // No frontmatter — fall back to an HTML comment at the top
  return renderHeader('html') + '\n' + content
}

const listTrackedFiles = (): string[] =>
  execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)

const main = () => {
  const args = process.argv.slice(2)
  const checkOnly = args.includes('--check')
  const explicitPaths = args.filter((a) => !a.startsWith('--'))

  const candidates = (explicitPaths.length > 0 ? explicitPaths : listTrackedFiles()).filter(isInScope)

  const missing: string[] = []
  let touched = 0

  for (const relPath of candidates) {
    const absPath = resolve(REPO_ROOT, relPath)
    let content: string
    try {
      content = readFileSync(absPath, 'utf8')
    } catch {
      continue
    }

    if (hasHeader(content)) continue

    if (checkOnly) {
      missing.push(relPath)
      continue
    }

    writeFileSync(absPath, applyHeader(content, relPath))
    touched++
  }

  if (checkOnly) {
    if (missing.length === 0) {
      console.log(`License header check passed (${candidates.length} files).`)
      process.exit(0)
    }
    console.error(`Missing MPL 2.0 license header in ${missing.length} file(s):`)
    for (const p of missing) console.error(`  ${p}`)
    console.error('\nRun `bun run license:fix` to add headers automatically.')
    process.exit(1)
  }

  if (touched === 0) {
    console.log(`License headers up to date (${candidates.length} files checked).`)
  } else {
    console.log(`Added MPL 2.0 license header to ${touched} file(s).`)
  }
}

main()
