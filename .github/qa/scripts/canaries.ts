#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { realAiCharters } from './findings'
import { type Run, runCommand } from './fix'

/** A recent bug fix whose reversal the canary build carries. */
export type Canary = { sha: string; title: string; charter: string }

const fixTitle = /^fix(\([^)]*\))?!?:\s*/
/** The explorer's browser (Playwright MCP) cannot swipe, drag or pinch, so fixes for those can never be found. */
const gestureTitle = /swipe|gesture|drag|pinch|long-?press/i
/**
 * Sensitive app code, matched on directory names. `fix.ts` keeps its looser substring match for auto-fix, which must
 * stay strict; a canary only needs to avoid these areas, so `revoked-device-modal.tsx` in chat is fine.
 */
export const isSensitive = (path: string) =>
  /(^|\/)(db|devices?|crypto|encryption|auth|sso|sessions?|sign-?in|powersync|sync|drizzle|migrations?)\//.test(path)

/** Tests, test helpers, translations and docs that a reversal leaves alone. */
const isTestOrDoc = (path: string) => /\.test\.|(^|\/)test-utils\/|\/locales\/|\.md$/.test(path)
/** App code a reversal may touch: `src/` without tests, test helpers, docs and translations. */
const isAppCode = (path: string) => path.startsWith('src/') && !isTestOrDoc(path)

/**
 * Runtime code outside `src/` that a src-only reversal would leave behind: the frontend build bundles `shared/`,
 * `public/`, `index.html` and the Vite config, and the canary backend runs `backend/` from the unpatched checkout.
 * `cli/`, `e2e/`, `.github/` and the other workspaces reach neither.
 */
const isOtherRuntime = (path: string) =>
  /^((shared|backend|public)\/|index\.html$|vite\.config\.ts$)/.test(path) && !isTestOrDoc(path)

/** Dependency manifests and lockfiles: a fix that touches one is a dependency change, not a bug the UI shows. */
const isDependencyFile = (path: string) => /(^|\/)(package\.json|bun\.lock|Cargo\.(toml|lock))$/.test(path)

/**
 * The charter that explores a path, first match wins. c1 (it needs its own onboarding build) and c7 (sync, always
 * sensitive) get no canaries.
 */
const charterByPath: [RegExp, string][] = [
  [/skill|project/i, 'c4-skills-projects'],
  [/model|provider|tinfoil/i, 'c3-models-providers'],
  [/widget|connection|integration|mcp|artifact/i, 'c5-widgets-connections'],
  [/setting|preference/i, 'c6-settings-data'],
  [/mobile|keyboard/i, 'c8-phone'],
  [/chat|^src\/(ai|acp)\//, 'c2-chat-power-user'],
]

/** The charter most of `paths` map to (ties go to the table's order), or undefined when none maps. */
const charterFor = (paths: string[]) => {
  const counts = charterByPath.map(([, charter]) => ({
    charter,
    count: paths.filter((p) => charterByPath.find(([pattern]) => pattern.test(p))?.[1] === charter).length,
  }))
  const best = counts.reduce((a, b) => (b.count > a.count ? b : a))
  return best.count > 0 ? best.charter : undefined
}

/** The charter a fix commit with these app paths would join the `picked` canaries under, or why it cannot. */
const charterOrReason = (paths: string[], picked: Canary[]): { charter: string } | { reason: string } => {
  if (paths.length === 0) return { reason: 'no app code under src/' }
  const charter = charterFor(paths)
  if (!charter) return { reason: 'no charter explores these paths' }
  if (picked.some((c) => c.charter === charter)) return { reason: `${charter} already has a canary` }
  // All canary findings replay on one stack, with the real AI or the fake one.
  const first = picked[0]
  if (first && realAiCharters.has(charter) !== realAiCharters.has(first.charter)) {
    return { reason: `${charter} needs the other kind of AI than ${first.charter}` }
  }
  return { charter }
}

type SelectOptions = {
  run?: Run
  ref?: string
  since?: string
  max?: number
  /** Commits chosen by hand: used as they are, with a bad one an error instead of a skip. */
  only?: string[]
  log?: (line: string) => void
}

/**
 * Pick up to `max` recent `fix:` commits on `ref` to revert for the canary build, newest first, and return them with
 * their combined patch, to apply in reverse. A commit qualifies when its app code (`isAppCode`) gets a charter from
 * `charterOrReason` and its reversal applies to the working tree on top of the earlier picks'. Every skip is logged
 * with its reason. With `only`, exactly those commits are tried and the heuristics (title, dependencies, other
 * runtime code, sensitive paths, age) are bypassed, since a person chose them; any commit that cannot be a canary
 * throws.
 */
export const selectCanaries = async ({
  run = runCommand,
  ref = 'origin/main',
  since = '8 weeks ago',
  max = 2,
  only,
  log = console.log,
}: SelectOptions = {}) => {
  if (only && only.length > max) throw new Error(`at most ${max} canaries, got ${only.length}`)
  const notSha = only?.find((sha) => !/^[0-9a-f]{7,40}$/i.test(sha))
  if (notSha !== undefined) throw new Error(`not a commit SHA: ${notSha}`)
  const commits = only
    ? await Promise.all(only.map((sha) => run(['git', 'log', '-1', '--format=%H%x09%s', sha])))
    : (await run(['git', 'log', ref, `--since=${since}`, '--format=%H%x09%s'])).split('\n').filter(Boolean)
  const canaries: Canary[] = []
  const patches: string[] = []
  for (const line of commits) {
    if (canaries.length === max) break
    const [sha, title] = line.trim().split('\t')
    const skip = (reason: string) => {
      const message = `skip ${sha.slice(0, 9)} ${title}: ${reason}`
      if (only) throw new Error(message)
      log(message)
    }
    if (!only) {
      if (!fixTitle.test(title)) continue
      if (gestureTitle.test(title)) {
        skip('the explorer cannot do touch gestures')
        continue
      }
    }
    const files = (await run(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', sha])).split('\n')
    const paths = files.filter(isAppCode)
    if (!only) {
      if (files.some(isDependencyFile)) {
        skip('it changes dependencies, which a src-only reversal would leave behind')
        continue
      }
      if (files.some(isOtherRuntime)) {
        skip('it also changes runtime code outside src/, which a src-only reversal would leave behind')
        continue
      }
      const sensitive = paths.find(isSensitive)
      if (sensitive) {
        skip(`sensitive path ${sensitive}`)
        continue
      }
    }
    const verdict = charterOrReason(paths, canaries)
    if ('reason' in verdict) {
      skip(verdict.reason)
      continue
    }
    const patch = await run(['git', 'diff', '--binary', `${sha}^`, sha, '--', ...paths])
    const applies = await run(['git', 'apply', '-R', '--check'], { stdin: [...patches, patch].join('') }).then(
      () => true,
      () => false,
    )
    if (!applies) {
      skip('its reversal does not apply to the current tree')
      continue
    }
    const { charter } = verdict
    canaries.push({ sha, title, charter })
    patches.push(patch)
    log(`pick ${sha.slice(0, 9)} ${title}: ${charter}`)
  }
  return { canaries, patch: patches.join('') }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, patch: { type: 'string' }, only: { type: 'string' } },
  })
  if (!values.out || !values.patch)
    throw new Error('usage: canaries.ts --out <manifest.json> --patch <file> [--only <sha,...>]')
  const { canaries, patch } = await selectCanaries({ only: values.only?.split(',').map((sha) => sha.trim()) })
  await writeFile(values.out, JSON.stringify(canaries, null, 2))
  await writeFile(values.patch, patch)
  console.log(`${canaries.length} canar${canaries.length === 1 ? 'y' : 'ies'} selected`)
}
