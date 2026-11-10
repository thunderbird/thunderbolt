/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Picks what the weekly docs audit reads: last week's commits, with their diffs, and a rotating quarter of the docs.
 *
 *   bun .github/scripts/docs-audit-select.ts --out docs-audit-out [--docs a.md,b.md] [--since '7 days ago']
 *
 * Writes `<out>/input.json` and one `<out>/diffs/<sha>.diff` per commit. `--docs` replaces the rotation for a manual
 * run. How the audit uses the output: .github/docs-audit/README.md.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

export type FileChange = { status: string; path: string; previous?: string }
export type Commit = { sha: string; subject: string; files: FileChange[] }
export type AuditedCommit = Commit & { diff: string }
export type AuditInput = { since: string; scope: string[]; rotation: string[]; changes: AuditedCommit[] }

/** Every doc gets a full review once per this many weeks. */
export const rotationWeeks = 4

const recordSeparator = '\x1e'
const fieldSeparator = '\x1f'
const dayMs = 86_400_000

/** Generated or vendored files whose changes say nothing a doc could have described. */
const noisePatterns = [
  /(^|\/)bun\.lockb?$/,
  /(^|\/)Cargo\.lock$/,
  /\/locales\/[^/]+\/messages\.(po|ts)$/,
  /^src\/acp\/iroh\/pkg\//,
  /^backend\/drizzle\/meta\//,
]

/**
 * True for the files the audit may edit: Markdown under `docs/` and every `AGENTS.md`. The `CLAUDE.md` files are a
 * symlink to or an `@AGENTS.md` import of their `AGENTS.md`, so the agent instructions live there.
 */
export const isInScope = (path: string): boolean =>
  (path.startsWith('docs/') && path.endsWith('.md')) || path === 'AGENTS.md' || path.endsWith('/AGENTS.md')

/** True for a generated or vendored file, matched against `noisePatterns`. */
const isNoise = (path: string): boolean => noisePatterns.some((pattern) => pattern.test(path))

/** Docs are what the audit checks, not evidence against them, so their own commits are skipped too. */
const isAuditable = (path: string): boolean => !isInScope(path) && !isNoise(path)

/**
 * Weeks since the Monday before the Unix epoch, read in UTC. Unlike an ISO week number it never resets at a year
 * boundary, so consecutive weeks always pick consecutive rotation slices.
 */
export const weekIndex = (date: Date): number => Math.floor((Math.floor(date.getTime() / dayMs) + 3) / 7)

/** The docs due this week. Interleaved by sorted path, so each slice mixes sections and sizes. */
export const rotationSlice = (files: string[], week: number): string[] =>
  [...files].sort().filter((_, index) => index % rotationWeeks === week % rotationWeeks)

/** Maps one `--name-status` line to a change. A rename or copy line carries the old path first, then the new one. */
const parseFileLine = (line: string): FileChange => {
  const [status, first, second] = line.split('\t')
  return second ? { status: status[0], path: second, previous: first } : { status: status[0], path: first }
}

/** Parses `git log --format=%x1e%h%x1f%s --name-status` output into commits. */
export const parseLog = (text: string): Commit[] =>
  text
    .split(recordSeparator)
    .filter((record) => record.trim())
    .map((record) => {
      const [header, ...lines] = record.split('\n')
      const [sha, subject] = header.split(fieldSeparator)
      return { sha, subject, files: lines.filter((line) => line.includes('\t')).map(parseFileLine) }
    })

/** Drops docs and noise files, then commits left with nothing to audit. */
export const relevantChanges = (commits: Commit[]): Commit[] =>
  commits
    .map((commit) => ({ ...commit, files: commit.files.filter((file) => isAuditable(file.path)) }))
    .filter((commit) => commit.files.length > 0)

/** Every path a commit's diff must cover: each changed file, plus the old path of a rename. */
export const diffPaths = (commit: Commit): string[] =>
  commit.files.flatMap((file) => (file.previous ? [file.previous, file.path] : [file.path]))

/** Splits a `--docs` list and rejects anything the audit may not edit. */
export const parseDocsOverride = (value: string, scope: string[]): string[] => {
  const docs = value
    .split(',')
    .map((doc) => doc.trim())
    .filter(Boolean)
  const outside = docs.filter((doc) => !scope.includes(doc))
  if (outside.length > 0) {
    throw new Error(`Not an in-scope doc: ${outside.join(', ')}`)
  }
  return docs
}

/** Runs git in the current checkout and returns its stdout. */
const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/** Writes the commit's diff, limited to its auditable files, and returns the commit with the diff's path. */
const withDiff = (commit: Commit, outDir: string): AuditedCommit => {
  const diff = join(outDir, 'diffs', `${commit.sha}.diff`)
  writeFileSync(diff, git(['show', '--format=', '--no-color', commit.sha, '--', ...diffPaths(commit)]))
  return { ...commit, diff }
}

const main = () => {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'docs-audit-out' },
      docs: { type: 'string', default: '' },
      since: { type: 'string', default: '7 days ago' },
    },
  })
  const scope = git(['ls-files']).split('\n').filter(isInScope).sort()
  const rotation = values.docs ? parseDocsOverride(values.docs, scope) : rotationSlice(scope, weekIndex(new Date()))
  const log = git(['log', `--since=${values.since}`, '--no-merges', '--format=%x1e%h%x1f%s', '--name-status'])

  mkdirSync(join(values.out, 'diffs'), { recursive: true })
  const changes = relevantChanges(parseLog(log)).map((commit) => withDiff(commit, values.out))
  const input: AuditInput = { since: values.since, scope, rotation, changes }
  writeFileSync(join(values.out, 'input.json'), `${JSON.stringify(input, null, 2)}\n`)
  console.log(`${scope.length} docs in scope, ${rotation.length} in rotation, ${changes.length} commits to check`)
}

if (import.meta.main) {
  main()
}
