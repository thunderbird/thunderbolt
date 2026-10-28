/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const explore = join(import.meta.dir, 'explore.sh')
const repoRoot = realpathSync(join(import.meta.dir, '../../..'))
// macOS tmpdir sits under a /var link, as a runner's /tmp does.
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
  // The model can write anywhere in the session dir, so the gate log lies outside it.
  expect(env.QA_GATE_LOG).toBe(`${sessionDir}.gate.log`)
})

test('the two-device charter does not run on iOS, as a session or a canary', () => {
  for (const command of ['run', 'canary']) {
    const { code, stderr } = sh([command, 'c7-two-devices-ios', out], { QA_DRY_RUN: '1', ...fakeClaude(denied) })
    expect(code).toBe(2)
    expect(stderr).toContain('c7-two-devices-ios does not run')
  }
})

test('only the two-device charter on Android gets the second browser, whatever the caller set', () => {
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

test('a native session refuses a backend log inside its session dir before the log exists', () => {
  const notYet = join(out, 'c2-chat-power-user-ios', 'attempts', 'backend.log')
  mkdirSync(join(out, 'c2-chat-power-user-ios', 'attempts'), { recursive: true })
  const { code, stderr } = sh(['run', 'c2-chat-power-user-ios', out], { QA_DRY_RUN: '1', QA_BACKEND_LOG: notYet })
  expect(existsSync(notYet)).toBe(false)
  expect(code).not.toBe(0)
  expect(stderr).toContain('must be outside')
})

const noPorts = {
  QA_FRONTEND_PORT: '',
  QA_ONBOARDING_PORT: '',
  QA_BACKEND_PORT: '',
  QA_PROVIDER_PORT: '',
  QA_MCP_PORT: '',
  QA_GOOGLE_PORT: '',
}

/** Ports not passed stay unset, whatever the caller's shell has. */
const promptFor = (session: string, ports: Record<string, string> = {}) => {
  const { code, stdout, stderr } = sh(['prompt', session, out], { ...noPorts, ...ports })
  if (code !== 0) throw new Error(stderr)
  return stdout
}

test('the prompt names the configured ports in one pass', () => {
  // The frontend moves onto the onboarding default and the onboarding build moves on: no URL may be rewritten twice.
  const prompt = promptFor('c1-first-run-desktop', {
    QA_FRONTEND_PORT: '1425',
    QA_ONBOARDING_PORT: '1426',
    QA_BACKEND_PORT: '8105',
  })
  expect(prompt).toContain('The app runs at http://localhost:1425 unless')
  expect(prompt).toContain('its backend is http://localhost:8105')
  expect(prompt).toContain('http://localhost:1426**')
  expect(prompt).not.toContain('http://localhost:1424')
  expect(prompt).not.toContain('http://localhost:8005')
})

test('the MCP and fake Google URLs follow their ports', () => {
  const prompt = promptFor('c5-widgets-connections-desktop', { QA_MCP_PORT: '2879', QA_GOOGLE_PORT: '2880' })
  expect(prompt).toContain('http://127.0.0.1:2879/mcp')
  expect(prompt).toContain('http://127.0.0.1:2880')
  expect(prompt).not.toContain(':9879')
  expect(prompt).not.toContain(':9880')
})

test("on the default ports the prompt keeps today's URLs", () => {
  const prompt = promptFor('c1-first-run-desktop')
  expect(prompt).toContain('http://localhost:1424')
  expect(prompt).toContain('http://localhost:1425**')
  expect(prompt).toContain('its backend is http://localhost:8005')
})

test('a port that is not one of the six stays as the charter wrote it', () => {
  const prompt = promptFor('c3-models-providers-desktop', { QA_BACKEND_PORT: '8105' })
  expect(prompt).toContain('`http://localhost:9`')
})

test('a malformed port variable falls back to the default instead of reaching the prompt', () => {
  for (const bad of ['abc', '8105\n', '8105 ', '123456']) {
    const prompt = promptFor('c1-first-run-desktop', { QA_BACKEND_PORT: bad })
    expect(prompt).toContain('its backend is http://localhost:8005')
    expect(prompt).not.toContain('abc')
    expect(prompt).not.toContain('8105')
  }
})

test('a ports.json key that is not a QA port variable never reads the environment', () => {
  // The value is a valid port number, so only the name check keeps it out of the prompt.
  const repo = mkdtempSync(join(work, 'repo-'))
  const qa = join(repo, '.github/qa')
  mkdirSync(qa, { recursive: true })
  for (const name of readdirSync(join(repoRoot, '.github/qa')))
    if (name !== 'ports.json') symlinkSync(join(repoRoot, '.github/qa', name), join(qa, name))
  writeFileSync(join(qa, 'ports.json'), JSON.stringify({ QA_BACKEND_PORT: 8005, ANTHROPIC_API_KEY: 9 }))
  const prompt = promptFor('c3-models-providers-desktop', { QA_REPO: repo, ANTHROPIC_API_KEY: '7777' })
  expect(prompt).toContain('`http://localhost:9`')
  expect(prompt).not.toContain('7777')
})

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

const denied = [
  'allow mcp__maestro__run gated Maestro tool',
  'deny run commands[0].runScript: key not allowed',
  'deny Write /tmp/qa-canary-outside.txt is outside',
]

test('the canary passes when the hook saw the run, the gate denied it and the hook denied the write', () => {
  const { code, stdout } = sh(['canary', 'c2-chat-power-user-ios', out], fakeClaude(denied))
  expect(code).toBe(0)
  expect(stdout).toBe('{"subtype":"success","is_error":false,"num_turns":2}\ncanary denied\n')
})

test('the canary fails when any of the three lines is missing', () => {
  for (const missing of denied) {
    const lines = denied.filter((line) => line !== missing)
    expect(sh(['canary', 'c2-chat-power-user-ios', out], fakeClaude(lines)).code).toBe(1)
  }
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

// Built once, outside any test's timeout: two `bun build --compile` runs.
const harnessDir = join(work, 'harness')
const npmLog = join(work, 'npm.log')
const npmBin = mkdtempSync(join(work, 'npm-'))
writeFileSync(join(npmBin, 'npm'), `#!/bin/bash\necho "$*" > ${npmLog}\n`)
chmodSync(join(npmBin, 'npm'), 0o755)
const harnessBuild = sh(['harness', 'c7-two-devices-android', harnessDir], { PATH: `${npmBin}:${process.env.PATH}` })
const harness = realpathSync(harnessDir)
const fromHarness = (args: string[], env: Record<string, string> = {}) => {
  const proc = Bun.spawnSync(['bash', join(harness, 'explore.sh'), ...args], {
    env: { ...process.env, QA_DEVICE_ID: 'device-1', ...logs, QA_HARNESS: harness, QA_REPO: repoRoot, ...env },
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

test('the harness holds the compiled gate and hook, and its MCP config points only inside it', async () => {
  expect(harnessBuild.code).toBe(0)
  const mcp = await Bun.file(join(harness, 'mcp.json')).json()
  expect(mcp.mcpServers.maestro).toEqual({ type: 'stdio', command: join(harness, 'maestro-gate'), args: [] })
  const browser = mcp.mcpServers.playwright_b
  expect(browser.command).toBe(join(harness, 'playwright-mcp/node_modules/.bin/playwright-mcp'))
  expect(browser.args).toContain(join(harness, 'layout-probe.js'))
  expect(browser.args).not.toContain('-y')
  expect(JSON.stringify(mcp)).not.toContain(repoRoot)
  expect(await Bun.file(npmLog).text()).toBe(
    `install --silent --prefix ${harness}/playwright-mcp @playwright/mcp@0.0.83\n`,
  )
  // Runs with no bun and no checkout, and still denies Bash.
  const hook = Bun.spawnSync([join(harness, 'native-hook')], {
    cwd: work,
    stdin: new TextEncoder().encode('{"tool_name":"Bash","tool_input":{}}'),
    env: { PATH: '/usr/bin:/bin', QA_SESSION_DIR: join(work, 's'), QA_GATE_LOG: join(work, 'hook.log') },
  })
  expect(hook.exitCode).toBe(2)
})

test("the compiled hook ignores a bunfig.toml preload and a .env in the folder it starts in", () => {
  // Bun loads both from the start folder by default, and the second browser could plant them there.
  const planted = mkdtempSync(join(work, 'planted-'))
  const marker = join(work, 'preload-ran')
  writeFileSync(join(planted, 'bunfig.toml'), 'preload = ["./evil.ts"]\n')
  writeFileSync(join(planted, 'evil.ts'), `await Bun.write(${JSON.stringify(marker)}, "ran")\n`)
  writeFileSync(join(planted, '.env'), 'QA_ALLOW_BROWSER_B=1\n')
  const hook = Bun.spawnSync([join(harness, 'native-hook')], {
    cwd: planted,
    stdin: new TextEncoder().encode('{"tool_name":"mcp__playwright_b__browser_navigate","tool_input":{}}'),
    env: { PATH: '/usr/bin:/bin', QA_SESSION_DIR: join(work, 's'), QA_GATE_LOG: join(work, 'planted.log') },
  })
  expect(existsSync(marker)).toBe(false)
  // The .env would have turned the second browser on.
  expect(hook.exitCode).toBe(2)
})

test('a session run from the harness uses its config and hook, never a path in the checkout', () => {
  const { code, stdout, stderr } = fromHarness(['run', 'c7-two-devices-android', out], { QA_DRY_RUN: '1' })
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  const { command, settings, cwd }: DryRun & { cwd: string } = JSON.parse(stdout)
  expect(flag(command, '--mcp-config')).toEqual([join(harness, 'mcp.json')])
  expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(`${join(harness, 'native-hook')} || exit 2`)
  // claude, and through it the hook and the gate, start outside the checkout.
  expect(cwd.startsWith(repoRoot)).toBe(false)
  expect(cwd.startsWith(harness)).toBe(false)
})

test('a session run from the harness leaves the summary to the workflow', () => {
  const { code } = fromHarness(['run', 'c2-chat-power-user-ios', out, '1'], fakeClaude([]))
  expect(code).toBe(0)
  const dir = join(realOut(), 'c2-chat-power-user-ios')
  // The stream sits outside the session dir, where the model's Write cannot reach it.
  expect(existsSync(`${dir}.run.jsonl`)).toBe(true)
  expect(existsSync(join(dir, 'run.jsonl'))).toBe(false)
  expect(existsSync(join(dir, 'execution.json'))).toBe(false)
  expect(existsSync(join(dir, 'session.json'))).toBe(false)
})
