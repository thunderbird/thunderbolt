/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isSensitive, selectCanaries, titleKeywords } from './canaries'
import { type Run, runCommand } from './fix'

let dir: string
let run: Run

/** Writes `files` (path → content) and commits them as `title`, `date` being the commit date. */
const commit = async (title: string, files: Record<string, string>, date?: string) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  await run(['git', 'add', '--all'])
  const env = date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : undefined
  await run(['git', 'commit', '--quiet', '--message', title], { env })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qa-canaries-'))
  run = (cmd, opts) => runCommand(cmd, { ...opts, cwd: dir })
  await run(['git', 'init', '--quiet', '--initial-branch', 'main'])
  await run(['git', 'config', 'user.email', 'qa@thunderbolt.test'])
  await run(['git', 'config', 'user.name', 'QA'])
  await commit('chore: start', {
    'src/skills/list.ts': 'export const list = 1\n',
    'src/components/chat/input.ts': 'export const input = 1\n',
    'src/settings/theme.ts': 'export const theme = 1\n',
    'src/lib/util.ts': 'export const util = 1\n',
    'src/db/schema.ts': 'export const schema = 1\n',
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('selectCanaries', () => {
  it('picks the newest revertible fixes and logs why every other fix was skipped', async () => {
    await commit('fix: old settings bug', { 'src/settings/theme.ts': 'export const theme = 0\n' }, '2020-01-01T00:00')
    await commit('fix(chat): keep the draft (#12)', {
      'src/components/chat/input.ts': 'export const input = 2\n',
      'src/components/chat/input.test.ts': 'test\n',
    })
    await commit('feat: chat input is three', { 'src/components/chat/input.ts': 'export const input = 3\n' })
    await commit('fix: theme sticks after a reload (#13)', {
      'src/settings/theme.ts': 'export const theme = 2\n',
      'src/settings/theme.test.ts': 'test\n',
    })
    await commit('fix: schema default', { 'src/db/schema.ts': 'export const schema = 2\n' })
    await commit('fix: util', { 'src/lib/util.ts': 'export const util = 2\n' })
    await commit('fix(e2e): wait longer', { 'e2e/chat.spec.ts': 'test\n', 'docs/qa.md': 'x\n' })
    await commit('fix: skills list shows every skill', { 'src/skills/list.ts': 'export const list = 2\n' })
    await commit('fix: skills list sorts', { 'src/skills/list.ts': 'export const list = 3\n' })
    await commit('fix(settings): settings again', { 'src/settings/theme.ts': 'export const theme = 3\n' })
    const log: string[] = []

    const { canaries } = await selectCanaries({ run, ref: 'main', log: (line) => log.push(line) })

    expect(canaries).toMatchObject([
      { title: 'fix(settings): settings again', charter: 'c6-settings-data', keywords: ['settings', 'again'] },
    ])
    expect(log.map((line) => line.replace(/^(\w+) \w+ /, '$1 '))).toEqual([
      'pick fix(settings): settings again: c6-settings-data',
      'skip fix: skills list sorts: c4-skills-projects needs the other kind of AI than c6-settings-data',
      'skip fix: skills list shows every skill: c4-skills-projects needs the other kind of AI than c6-settings-data',
      'skip fix(e2e): wait longer: no app code under src/',
      'skip fix: util: no charter explores these paths',
      'skip fix: schema default: sensitive path src/db/schema.ts',
      'skip fix: theme sticks after a reload (#13): c6-settings-data already has a canary',
      'skip fix(chat): keep the draft (#12): its reversal does not apply to the current tree',
    ])
  })

  it('reverts only the app code, on top of the earlier picks, and stops at two', async () => {
    await commit('fix: mobile nav', { 'src/components/ui/mobile-nav.ts': 'export const nav = 1\n' })
    await commit('fix: chat input', {
      'src/components/chat/input.ts': 'export const input = 2\n',
      'src/components/chat/input.test.ts': 'test 2\n',
      'src/locales/en/messages.po': 'msgid "x"\n',
    })
    await commit('fix: theme', { 'src/settings/theme.ts': 'export const theme = 2\n' })

    const log: string[] = []
    const { canaries, patch } = await selectCanaries({ run, ref: 'main', log: (line) => log.push(line) })
    await run(['git', 'apply', '-R'], { stdin: patch })

    expect(canaries.map((c) => c.charter)).toEqual(['c6-settings-data', 'c2-chat-power-user'])
    expect(log).toHaveLength(2)
    expect(await readFile(join(dir, 'src/components/ui/mobile-nav.ts'), 'utf8')).toBe('export const nav = 1\n')
    expect(await readFile(join(dir, 'src/settings/theme.ts'), 'utf8')).toBe('export const theme = 1\n')
    expect(await readFile(join(dir, 'src/components/chat/input.ts'), 'utf8')).toBe('export const input = 1\n')
    expect(await readFile(join(dir, 'src/components/chat/input.test.ts'), 'utf8')).toBe('test 2\n')
    expect(await readFile(join(dir, 'src/locales/en/messages.po'), 'utf8')).toBe('msgid "x"\n')
  })

  it('selects nothing when no fix qualifies', async () => {
    await commit('feat: skills', { 'src/skills/list.ts': 'export const list = 2\n' })
    expect(await selectCanaries({ run, ref: 'main', log: () => {} })).toEqual({ canaries: [], patch: '' })
  })
})

it('skips gesture fixes', async () => {
  await commit('fix(chat): open the drawer with a left-edge Swipe', {
    'src/components/chat/input.ts': 'export const input = 2\n',
  })
  const log: string[] = []
  const { canaries } = await selectCanaries({ run, ref: 'main', log: (line) => log.push(line) })
  expect(canaries).toEqual([])
  expect(log[0]).toContain('touch gestures')
})

it('skips fixes that change dependencies, even with app code in the same commit', async () => {
  await commit('fix: upgrade the theme library', {
    'package.json': '{}\n',
    'src/settings/theme.ts': 'export const theme = 2\n',
  })
  const log: string[] = []
  const { canaries } = await selectCanaries({ run, ref: 'main', log: (line) => log.push(line) })
  expect(canaries).toEqual([])
  expect(log[0]).toContain('changes dependencies')
})

describe('isSensitive', () => {
  it('matches sensitive directories, not look-alike file names', () => {
    expect(isSensitive('src/components/chat/revoked-device-modal.tsx')).toBe(false)
    expect(isSensitive('src/devices/list.tsx')).toBe(true)
    expect(isSensitive('src/crypto/keys.ts')).toBe(true)
    expect(isSensitive('src/db/schema.ts')).toBe(true)
  })
})

describe('titleKeywords', () => {
  it('drops the type, scope, PR number, short and filler words', () => {
    expect(titleKeywords("fix(THU-1): honor calendar_id and surface Google's reason with the API (#1329)")).toEqual([
      'honor',
      'calendar',
      'surface',
      'google',
      'reason',
    ])
  })
})

it('skips fixes that also change runtime code outside src/, but not their tests', async () => {
  await commit('fix: shared default', {
    'shared/defaults/models.ts': 'export const models = 1\n',
    'src/settings/theme.ts': 'export const theme = 2\n',
  })
  await commit('fix: theme with a shared test', {
    'shared/defaults/models.test.ts': 'test\n',
    'src/settings/theme.ts': 'export const theme = 3\n',
  })
  const log: string[] = []
  const { canaries } = await selectCanaries({ run, ref: 'main', log: (line) => log.push(line) })
  expect(canaries.map((c) => c.title)).toEqual(['fix: theme with a shared test'])
  expect(log[1]).toContain('outside src/')
})
