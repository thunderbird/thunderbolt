#!/usr/bin/env bun
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Production-bundle analyzer. Builds the app (or reuses an existing build),
 * gzip-sizes every emitted JS chunk, and attributes the FCP-blocking weight to
 * the entry chunk vs on-demand route chunks. Output conforms to the
 * `BundleReport` type and is compared against the repo's `size-limit` budgets
 * in package.json.
 *
 * Only the report path is printed to stdout; the build log, the human summary,
 * and any budget overages go to stderr — mirroring scripts/run.ts.
 *
 * Usage:
 *   bun scripts/analyze-bundle.ts            # always rebuilds
 *   bun scripts/analyze-bundle.ts --reuse    # reuse dist/ if present
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { REPO_ROOT } from './lib/env'
import type { BundleReport } from './lib/types'

const BUILD_SCRIPT = 'build' // package.json → "build": "vite build"
const ASSETS_DIR = 'dist/assets' // vite emits entry-[hash].js + route chunks here

const flag = (name: string): boolean => process.argv.includes(`--${name}`)

/** A size-limit budget entry from package.json ("path" glob + optional "limit"). */
type SizeLimitEntry = { name?: string; path: string | string[]; gzip?: boolean; limit?: string }

const readSizeLimits = (): SizeLimitEntry[] => {
  const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8')) as { 'size-limit'?: SizeLimitEntry[] }
  return pkg['size-limit'] ?? []
}

const runBuild = (): void => {
  console.error(`perf-hunt/bundle: running \`bun run ${BUILD_SCRIPT}\` (this can take a few minutes)…`)
  const proc = Bun.spawnSync(['bun', 'run', BUILD_SCRIPT], { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit' })
  if (proc.exitCode !== 0) {
    console.error(`perf-hunt/bundle: build failed (exit ${proc.exitCode}). See output above.`)
    process.exit(1)
  }
}

const gzipBytesOf = (absPath: string): number => Bun.gzipSync(readFileSync(absPath)).byteLength

type Chunk = { file: string; gzipBytes: number }

/** Gzip-size every .js chunk in the assets dir. `file` is repo-relative. */
const measureChunks = (assetsAbs: string): Chunk[] =>
  readdirSync(assetsAbs)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: `${ASSETS_DIR}/${f}`, gzipBytes: gzipBytesOf(`${assetsAbs}/${f}`) }))

const humanBytes = (n: number): string => `${(n / 1024).toFixed(1)} KB`

/** Parse a size-limit "limit" (e.g. "180 KB", "1 MB") into bytes; 0 if absent/unparseable. */
const parseLimit = (limit?: string): number => {
  if (!limit) return 0
  const match = limit.trim().match(/^([\d.]+)\s*(k|m)?b$/i)
  if (!match) return 0
  const value = Number(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  const factor = unit === 'm' ? 1024 * 1024 : unit === 'k' ? 1024 : 1
  return value * factor
}

const main = () => {
  const assetsAbs = `${REPO_ROOT}/${ASSETS_DIR}`
  const canReuse = flag('reuse') && existsSync(assetsAbs)
  if (canReuse) console.error(`perf-hunt/bundle: --reuse set and ${ASSETS_DIR} exists — skipping rebuild`)
  else runBuild()

  if (!existsSync(assetsAbs)) {
    console.error(`perf-hunt/bundle: assets dir not found at ${assetsAbs} after build`)
    process.exit(1)
  }

  const chunks = measureChunks(assetsAbs)
  if (chunks.length === 0) {
    console.error(`perf-hunt/bundle: no .js chunks found in ${assetsAbs}`)
    process.exit(1)
  }

  const entryChunks = chunks.filter((c) => /entry-[^/]+\.js$/.test(c.file))
  const entryChunkGzipBytes = entryChunks.reduce((sum, c) => sum + c.gzipBytes, 0)
  const totalJsGzipBytes = chunks.reduce((sum, c) => sum + c.gzipBytes, 0)
  const largestChunks = [...chunks].sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 10)

  // A cheap manifest exists only if we can trivially read it; we don't attempt
  // per-module attribution here, so suspectEntryModules stays empty by design.
  const suspectEntryModules: string[] = []

  const report: BundleReport = { entryChunkGzipBytes, totalJsGzipBytes, largestChunks, suspectEntryModules }

  const reportPath = `${REPO_ROOT}/.perf-hunt/bundle-report.json`
  mkdirSync(`${REPO_ROOT}/.perf-hunt`, { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  // Human summary + budget check → stderr (stdout stays reserved for the path).
  console.error(`perf-hunt/bundle: entry=${humanBytes(entryChunkGzipBytes)} total=${humanBytes(totalJsGzipBytes)} (${chunks.length} chunks, gzip)`)
  const limits = readSizeLimits()
  for (const entry of limits) {
    const patterns = (Array.isArray(entry.path) ? entry.path : [entry.path]).map((p) => new Bun.Glob(p))
    const matched = chunks.filter((c) => patterns.some((g) => g.match(c.file)))
    const gzipSum = matched.reduce((sum, c) => sum + c.gzipBytes, 0)
    const budget = parseLimit(entry.limit)
    const budgetLabel = budget > 0 ? humanBytes(budget) : 'no numeric budget'
    const status = budget > 0 && gzipSum > budget ? 'EXCEEDS' : 'ok'
    console.error(`perf-hunt/bundle: budget "${entry.name ?? entry.path}" = ${humanBytes(gzipSum)} / ${budgetLabel} → ${status}`)
  }

  // The ONLY thing the agent parses from stdout: the path to the report JSON.
  console.log(reportPath)
}

main()
