/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookDecision } from './native-hook'

// tmpdir() is under /var on macOS, itself a symlink to /private/var, so the session dir is reached through a link.
const sessionDir = mkdtempSync(join(tmpdir(), 'qa-hook-'))
const outside = mkdtempSync(join(tmpdir(), 'qa-hook-outside-'))
symlinkSync(outside, join(sessionDir, 'escape'))
symlinkSync(join(outside, 'new.json'), join(sessionDir, 'dangling.json'))

const allows = (tool_name: string, tool_input: Record<string, string> = {}, allowBrowserB = false) =>
  hookDecision({ tool_name, tool_input }, sessionDir, allowBrowserB).allow

test('the five gated Maestro tools are allowed and every other Maestro tool is not', () => {
  for (const tool of ['run', 'inspect_screen', 'take_screenshot', 'cheat_sheet', 'read_logs']) {
    expect(allows(`mcp__maestro__${tool}`)).toBe(true)
  }
  for (const tool of ['list_devices', 'open_maestro_viewer', 'run_on_cloud', 'list_cloud_devices']) {
    expect(allows(`mcp__maestro__${tool}`)).toBe(false)
  }
})

test('Bash, Read and unknown tools are denied', () => {
  for (const tool of ['Bash', 'Read', 'Glob', 'WebFetch', 'mcp__playwright__browser_click', 'Task']) {
    expect(allows(tool)).toBe(false)
  }
})

test('Write and Edit are allowed only inside the session dir', () => {
  expect(allows('Write', { file_path: join(sessionDir, 'findings/1.json') })).toBe(true)
  expect(allows('Edit', { file_path: join(sessionDir, 'notes.md') })).toBe(true)
  expect(allows('Write', { file_path: join(sessionDir, '../x') })).toBe(false)
  expect(allows('Write', { file_path: '/tmp/x' })).toBe(false)
  expect(allows('Write', { file_path: sessionDir })).toBe(false)
  expect(allows('Write', { file_path: `${sessionDir}-sibling/x.json` })).toBe(false)
  expect(allows('Write', {})).toBe(false)
})

test('a symlink inside the session dir that points out is denied, also when its target does not exist yet', () => {
  expect(allows('Write', { file_path: join(sessionDir, 'escape/x.json') })).toBe(false)
  expect(allows('Write', { file_path: join(sessionDir, 'escape/deeper/x.json') })).toBe(false)
  expect(allows('Write', { file_path: join(sessionDir, 'dangling.json') })).toBe(false)
})

test('a session dir given by its real path or through its link resolves to the same folder', () => {
  mkdirSync(join(sessionDir, 'findings'), { recursive: true })
  const real = join('/private', sessionDir)
  expect(
    hookDecision({ tool_name: 'Write', tool_input: { file_path: join(real, 'findings/2.json') } }, sessionDir, false)
      .allow,
  ).toBe(true)
  expect(
    hookDecision({ tool_name: 'Write', tool_input: { file_path: join(sessionDir, 'findings/2.json') } }, real, false)
      .allow,
  ).toBe(true)
})

test('the second browser is allowed only when the harness says so, and never its unsafe code tool', () => {
  expect(allows('mcp__playwright_b__browser_click')).toBe(false)
  expect(allows('mcp__playwright_b__browser_click', {}, true)).toBe(true)
  expect(allows('mcp__playwright_b__browser_run_code_unsafe', {}, true)).toBe(false)
})

const runHook = async (input: Parameters<typeof hookDecision>[0]) => {
  const gateLog = join(sessionDir, 'gate.log')
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'native-hook.ts')], {
    stdin: new Blob([JSON.stringify(input)]),
    stderr: 'pipe',
    env: { PATH: process.env.PATH, QA_SESSION_DIR: sessionDir, QA_GATE_LOG: gateLog },
  })
  return { code: await proc.exited, log: readFileSync(gateLog, 'utf8') }
}

test('run as the hook, a Bash call exits 2 and is logged as denied', async () => {
  const { code, log } = await runHook({ tool_name: 'Bash', tool_input: { command: 'env' } })
  expect(code).toBe(2)
  expect(log).toContain('deny Bash')
})

test('run as the hook, a gated Maestro call exits 0 and is logged as allowed', async () => {
  const { code, log } = await runHook({ tool_name: 'mcp__maestro__run', tool_input: { yaml: '- back' } })
  expect(code).toBe(0)
  expect(log).toContain('allow mcp__maestro__run')
})
