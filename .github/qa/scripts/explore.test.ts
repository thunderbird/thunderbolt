/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const explore = join(import.meta.dir, 'explore.sh')
const repoRoot = realpathSync(join(import.meta.dir, '../../..'))
// Under /var on macOS, a link to /private/var, so the session dir is reached through a link as on a runner's /tmp.
const work = mkdtempSync(join(tmpdir(), 'qa-explore-'))
const out = join(work, 'out')
const realOut = () => realpathSync(out)
const logs = { QA_WEBVIEW_LOG: join(work, 'webview.log'), QA_BACKEND_LOG: join(work, 'backend.log') }
writeFileSync(logs.QA_WEBVIEW_LOG, '')
writeFileSync(logs.QA_BACKEND_LOG, '')
const outside = '/tmp/qa-canary-outside.txt'

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
  rmSync(outside, { force: true })
})

const sh = (args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawnSync(['bash', explore, ...args], {
    env: { ...process.env, QA_DEVICE_ID: 'device-1', ...logs, ...env },
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

type DryRun = {
  command: string[]
  settings: { hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] } }
  env: Record<string, string>
}

const dryRun = (session: string, env: Record<string, string> = {}): DryRun => {
  const { code, stdout, stderr } = sh(['run', session, out], { QA_DRY_RUN: '1', ...env })
  if (code !== 0) throw new Error(stderr)
  return JSON.parse(stdout)
}

/** The values a variadic flag got: every argument after it up to the next flag. */
const flag = (command: string[], name: string) => {
  const start = command.indexOf(name)
  if (start === -1) return undefined
  const end = command.findIndex((arg, index) => index > start && arg.startsWith('--'))
  return command.slice(start + 1, end === -1 ? undefined : end)
}

test('a native session gets only Write and the gated Maestro tools, behind a hook that denies when it crashes', () => {
  const { command, settings, env } = dryRun('c1-first-run-ios')
  const sessionDir = join(realOut(), 'c1-first-run-ios')
  expect(command.slice(0, 2)).toEqual(['env', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1'])
  expect(flag(command, '--tools')).toEqual(['Write'])
  expect(flag(command, '--allowedTools')).toEqual(['mcp__maestro__*', `Edit(/${sessionDir}/**)`])
  expect(flag(command, '--disallowedTools')).toEqual([
    'Bash',
    'mcp__maestro__list_devices',
    'mcp__maestro__open_maestro_viewer',
  ])
  expect(flag(command, '--strict-mcp-config')).toEqual([])
  expect(flag(command, '--mcp-config')).toEqual(['.github/qa/mcp-maestro.json'])
  expect(flag(command, '--setting-sources')).toEqual(['user'])
  expect(command).not.toContain('--permission-mode')
  expect(command[command.indexOf('-p') + 1]).toContain(`- Output directory: \`${sessionDir}\``)

  expect(settings.hooks.PreToolUse).toEqual([
    {
      matcher: '*',
      hooks: [{ type: 'command', command: `bun ${repoRoot}/.github/qa/scripts/native-hook.ts || exit 2` }],
    },
  ])
  expect(env.QA_SESSION_DIR).toBe(sessionDir)
  expect(env.QA_PLATFORM).toBe('ios')
  // The model can write anywhere in the session dir, so the log the canary and the reviewers read lies outside it.
  expect(env.QA_GATE_LOG).toBe(`${sessionDir}.gate.log`)
})

test('only the two-device charter gets the second browser, whatever the caller set', () => {
  const single = dryRun('c2-chat-power-user-android', { QA_ALLOW_BROWSER_B: '1' })
  expect(single.env.QA_ALLOW_BROWSER_B).toBe('0')
  expect(flag(single.command, '--allowedTools')).not.toContain('mcp__playwright_b__*')

  const c7 = dryRun('c7-two-devices-android')
  expect(c7.env.QA_ALLOW_BROWSER_B).toBe('1')
  expect(flag(c7.command, '--allowedTools')).toContain('mcp__playwright_b__*')
  expect(flag(c7.command, '--disallowedTools')).toContain('mcp__playwright_b__browser_run_code_unsafe')
  expect(flag(c7.command, '--mcp-config')).toEqual(['.github/qa/mcp-maestro.json', '.github/qa/mcp-two-devices.json'])
})

test('a native session refuses a WebView log inside its session dir', () => {
  const dir = join(out, 'c2-chat-power-user-ios')
  sh(['run', 'c2-chat-power-user-ios', out], { QA_DRY_RUN: '1' })
  const planted = join(dir, 'webview.log')
  writeFileSync(planted, '')
  const { code, stderr } = sh(['run', 'c2-chat-power-user-ios', out], { QA_DRY_RUN: '1', QA_WEBVIEW_LOG: planted })
  expect(code).not.toBe(0)
  expect(stderr).toContain('must be outside')
})

/** A stand-in `claude` that logs the given gate lines, may write the outside file, and prints a tool result. */
const fakeClaude = (gateLines: string[], writeOutside = false) => {
  const bin = mkdtempSync(join(work, 'bin-'))
  const script = [
    '#!/bin/bash',
    ...gateLines.map((line) => `echo '${line}' >> "$QA_GATE_LOG"`),
    writeOutside ? `echo canary > ${outside}` : '',
    `echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"a tool said this"}]}}'`,
    `echo '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"done"}'`,
  ].join('\n')
  writeFileSync(join(bin, 'claude'), script)
  chmodSync(join(bin, 'claude'), 0o755)
  return { PATH: `${bin}:${process.env.PATH}` }
}

const denied = ['deny run commands[0].runScript: key not allowed', 'deny Write /tmp/qa-canary-outside.txt is outside']

test('the canary passes when the gate denied the script and the write, and prints only the result line', () => {
  const { code, stdout } = sh(['canary', 'c2-chat-power-user-ios', out], fakeClaude(denied))
  expect(code).toBe(0)
  expect(stdout).toBe('{"subtype":"success","is_error":false,"num_turns":2}\ncanary denied\n')
})

test('the canary fails when either call was not denied', () => {
  expect(sh(['canary', 'c2-chat-power-user-ios', out], fakeClaude([denied[0]])).code).toBe(1)
  expect(sh(['canary', 'c2-chat-power-user-ios', out], fakeClaude([denied[1]])).code).toBe(1)
})

test('the canary fails when the outside file exists, even with both denials logged', () => {
  const { code, stderr } = sh(['canary', 'c2-chat-power-user-ios', out], fakeClaude(denied, true))
  expect(code).toBe(1)
  expect(stderr).toContain('canary NOT denied')
  expect(existsSync(outside)).toBe(true)
})

test('the canary refuses a web session', () => {
  expect(sh(['canary', 'c2-chat-power-user-phone', out], fakeClaude(denied)).code).toBe(2)
})
