/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkMaestroFlow } from './maestro-flow'
import {
  type GateContext,
  gateTools,
  handleCall,
  type MaestroClient,
  restartsApp,
  type ToolResult,
} from './maestro-gate'

type HierarchyNode = { attributes: Record<string, string>; children?: HierarchyNode[] }
type InspectElement = {
  b: string
  a11y: string
  txt: string
  val: string
  hint: string
  rid: string
  focused: boolean
  c: InspectElement[]
}
type Call = { name: string; args: Parameters<MaestroClient['callTool']>[1] }

const fixtureDir = join(import.meta.dir, '../fixtures/native')

/** A `maestro hierarchy` node in the abbreviated form `inspect_screen` returns. */
const toInspect = ({ attributes, children = [] }: HierarchyNode): InspectElement => ({
  b: attributes.bounds,
  a11y: attributes.accessibilityText,
  txt: attributes.text,
  val: attributes.value,
  hint: attributes.hintText,
  rid: attributes['resource-id'],
  focused: attributes.focused === 'true',
  c: children.map(toInspect),
})

// A foreign screen: its first element is not our app, as under the Control Center.
const controlCenter = {
  ui_schema: { defaults: {} },
  elements: [{ b: '[0,0][440,956]', c: [{ b: '[52,61][432,114]', a11y: 'Wi-Fi', focused: true }] }],
}

/** The `inspect_screen` text for a fixture name, or `control-center`. */
const screenText = (name: string): string => {
  if (name === 'control-center') return JSON.stringify(controlCenter)
  const json = readFileSync(join(fixtureDir, `${name}.json`), 'utf8')
  if (name.startsWith('inspect-')) return json
  const root: HierarchyNode = JSON.parse(json)
  return JSON.stringify({ ui_schema: { defaults: {} }, elements: (root.children ?? []).map(toInspect) })
}

const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], isError })

/** A WebView console line as `log stream` writes it on iOS. */
const consoleLine = (message: string) =>
  `2026-10-19 22:14:37.386 Df Thunderbolt Dev[1:2] [com.apple.WebKit:Generic] WebContent[3] ` +
  `tauri://localhost/assets/entry.js:1:2: CONSOLE ERROR ${message}\n`

const nameBug = '[qa-layout] focus-covered textbox "Enter your name"'

/**
 * A gate over a fake Maestro that records every call. `inspect_screen` walks through `screens` and then repeats the
 * last one. Each `run` writes the next batch of `probe` messages to the WebView log, as the app's probe would while
 * the commands run. `respond` can answer any call first.
 */
const fakeGate = ({
  screen = 'hier-00-welcome',
  screens = [screen],
  probe = [],
  respond,
}: {
  screen?: string
  screens?: string[]
  probe?: string[][]
  respond?: (call: Call, index: number) => ToolResult | undefined
} = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-gate-'))
  const calls: Call[] = []
  let inspected = 0
  const batches = [...probe]
  const ctx: GateContext = {
    client: {
      callTool: async (name, args) => {
        const call = { name, args }
        calls.push(call)
        const answer = respond?.(call, calls.length - 1)
        if (answer) return answer
        if (name === 'run') appendFileSync(ctx.webviewLog, (batches.shift() ?? []).map(consoleLine).join(''))
        if (name === 'inspect_screen') return textResult(screenText(screens[Math.min(inspected++, screens.length - 1)]))
        if (name === 'take_screenshot') {
          return {
            // Maestro 2.11 sends iOS screenshots as JPEG.
            content: [{ type: 'image', data: Buffer.from('jpeg bytes').toString('base64'), mimeType: 'image/jpeg' }],
          }
        }
        return textResult('{"success":true}')
      },
    },
    platform: 'ios',
    deviceId: 'UDID-1',
    appId: 'net.thunderbird.thunderbolt.dev',
    appName: 'Thunderbolt Dev',
    sessionDir: dir,
    webviewLog: join(dir, 'webview.log'),
    backendLog: join(dir, 'backend.log'),
    gateLog: join(dir, 'gate.log'),
    probeWaitMs: 0,
  }
  const log = async () => readFileSync(ctx.gateLog, 'utf8')
  return { ctx, calls, log, dir }
}

const text = (result: ToolResult) =>
  result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')

test('the agent sees exactly the five gated tools', () =>
  expect(gateTools.map((tool) => tool.name).sort()).toEqual([
    'cheat_sheet',
    'inspect_screen',
    'read_logs',
    'run',
    'take_screenshot',
  ]))

test('a denied run never reaches Maestro and is logged', async () => {
  const { ctx, calls, log } = fakeGate()
  const result = await handleCall('run', { yaml: '- runScript: x.js' }, ctx)
  expect(result.isError).toBe(true)
  expect(text(result)).toStartWith('denied: ')
  expect(calls).toEqual([])
  expect(await log()).toContain('deny run')
})

test('an allowed run sends our serialization to our device and appends the probe lines', async () => {
  const { ctx, calls, log } = fakeGate({ screen: 'hier-name-kb', probe: [['[qa-layout] ready', nameBug]] })
  const result = await handleCall('run', { yaml: '- waitForAnimationToEnd', device_id: 'other' }, ctx)
  expect(result.isError).toBe(true) // device_id is not the agent's to give
  expect(calls).toEqual([])
  const ok = await handleCall('run', { yaml: '- waitForAnimationToEnd' }, ctx)
  expect(calls[0]).toEqual({ name: 'run', args: { device_id: ctx.deviceId, yaml: expect.stringMatching(/^appId: /) } })
  expect(text(ok).split('\n').slice(-2)).toEqual(['[qa-layout] ready keyboard=[0,611][440,956]', nameBug])
  expect(await log()).toContain('allow run')
})

test('a tool the gate does not offer, or an extra argument, is refused without reaching Maestro', async () => {
  const { ctx, calls, log } = fakeGate()
  for (const [name, args] of [
    ['list_devices', {}],
    ['run_on_cloud', { app_file: 'x', flows: 'y' }],
    ['inspect_screen', { device_id: 'other' }],
    ['run', { yaml: '- back', env: { A: 'b' } }],
    ['run', { files: ['/tmp/x.yaml'] }],
  ] as const) {
    expect((await handleCall(name, args, ctx)).isError).toBe(true)
  }
  expect(calls).toEqual([])
  expect(await log()).toContain('deny list_devices')
})

test('measures after a run that only waits, and each probe line comes back once', async () => {
  const { ctx } = fakeGate({ screen: 'inspect-chat-kb', probe: [['[qa-layout] ready'], [nameBug]] })
  const first = text(await handleCall('run', { yaml: '- waitForAnimationToEnd' }, ctx))
  expect(first).toMatch(/\[qa-layout\] ready keyboard=\[0,\d+\]\[440,956\]$/)
  const second = text(await handleCall('run', { yaml: '- waitForAnimationToEnd' }, ctx))
  expect(second).toMatch(/\[qa-layout\] ready keyboard=\[0,\d+\]\[440,956\]\n\[qa-layout\] focus-covered/)
  expect(text(await handleCall('run', { yaml: '- waitForAnimationToEnd' }, ctx))).not.toContain('focus-covered')
})

test('without the probe ready line since launch there is no ready line', async () => {
  const { ctx } = fakeGate({ probe: [[], ['[qa-layout] ready'], []] })
  expect(text(await handleCall('run', { yaml: '- back' }, ctx))).toEndWith(
    '[qa-gate] layout probe not seen since launch',
  )
  expect(text(await handleCall('run', { yaml: '- back' }, ctx))).toEndWith('[qa-layout] ready keyboard=none')
  // A relaunch reloads the page: its probe has to say ready again.
  expect(text(await handleCall('run', { yaml: '- launchApp' }, ctx))).toEndWith(
    '[qa-gate] layout probe not seen since launch',
  )
})

test('a flow restarts the app with stopApp, killApp or launchApp, unless launchApp keeps it running', () => {
  const ourFlow = (yaml: string) => {
    const check = checkMaestroFlow(yaml, { appId: 'net.thunderbird.thunderbolt.dev' })
    if (!check.ok) throw new Error(check.problems.join('; '))
    return check.yaml
  }
  for (const yaml of [
    '- launchApp',
    '- launchApp: net.thunderbird.thunderbolt.dev',
    '- launchApp:\n    appId: net.thunderbird.thunderbolt.dev',
    '- stopApp',
    '- tapOn: Hi\n- retry:\n    commands:\n      - killApp\n      - launchApp:\n          stopApp: false',
    '- launchApp:\n    stopApp: true',
  ]) {
    expect(restartsApp(ourFlow(yaml))).toBe(true)
  }
  for (const yaml of [
    '- back',
    '- launchApp:\n    stopApp: false',
    '- launchApp:\n    appId: net.thunderbird.thunderbolt.dev\n    stopApp: false\n- back',
    '- tapOn: launchApp',
  ]) {
    expect(restartsApp(ourFlow(yaml))).toBe(false)
  }
})

test('the probe lines come only with run and inspect_screen, and read_logs keeps every other line', async () => {
  const { ctx } = fakeGate({ probe: [['[qa-layout] ready', 'Uncaught TypeError: x', nameBug]] })
  expect(text(await handleCall('run', { yaml: '- back' }, ctx))).toContain(nameBug)
  expect(text(await handleCall('read_logs', {}, ctx))).toEndWith('CONSOLE ERROR Uncaught TypeError: x')

  appendFileSync(ctx.webviewLog, consoleLine('[qa-layout] behind-keyboard button "Continue"') + consoleLine('later'))
  expect(text(await handleCall('read_logs', {}, ctx))).toEndWith('CONSOLE ERROR later')
  expect(text(await handleCall('inspect_screen', {}, ctx))).toEndWith('[qa-layout] behind-keyboard button "Continue"')
})

test('a screen Maestro cannot show after a run keeps the run result and says so', async () => {
  const { ctx } = fakeGate({
    respond: ({ name }) => (name === 'inspect_screen' ? textResult('Error: device not reachable', true) : undefined),
  })
  const result = await handleCall('run', { yaml: '- tapOn: Hi' }, ctx)
  expect(result.isError).toBe(false)
  expect(text(result)).toBe('{"success":true}\n[qa-gate] could not read the screen after this run')
})

test('a run that leaves the app is followed by a relaunch and the layout of our screen', async () => {
  const { ctx, calls } = fakeGate({ screens: ['control-center', 'hier-00-welcome'], probe: [['[qa-layout] ready']] })
  const result = await handleCall('run', { yaml: '- swipe:\n    direction: DOWN' }, ctx)
  expect(calls.map((call) => call.name)).toEqual(['run', 'inspect_screen', 'run', 'inspect_screen'])
  expect(calls[2].args.yaml).toBe(`appId: ${ctx.appId}\n---\n- pressKey: Home\n- launchApp:\n    stopApp: false\n`)
  expect(calls[2].args.device_id).toBe(ctx.deviceId)
  expect(text(result)).toContain('the harness reopened it')
  // The relaunch keeps the app running, so the probe's earlier ready line still counts.
  expect(text(result)).toEndWith('[qa-layout] ready keyboard=none')
})

// The iOS root names the app in a11y; the Android one in txt with an empty a11y.
test.each([
  ['an iOS root with the name in a11y', { a11y: 'Thunderbolt' }, true],
  ['an Android root with the name in txt', { txt: 'Thunderbolt' }, true],
  ['a root naming another app in txt', { txt: 'Settings' }, false],
])('%s: in front is %p', async (_name, root, ours) => {
  const tree = { ui_schema: { defaults: {} }, elements: [{ b: '[0,0][1080,2400]', ...root }] }
  const { ctx, calls } = fakeGate({
    probe: [['[qa-layout] ready']],
    respond: (call) => (call.name === 'inspect_screen' ? textResult(JSON.stringify(tree)) : undefined),
  })
  ctx.appName = 'Thunderbolt'
  const result = await handleCall('run', { yaml: '- tapOn: Hi' }, ctx)
  expect(calls.filter((call) => call.name === 'run')).toHaveLength(ours ? 1 : 2)
  expect(text(result).includes('the app is still not in the foreground')).toBe(!ours)
})

/** A gate on the Android emulator, whose app has no `.dev` id. */
const androidGate = (options: Parameters<typeof fakeGate>[0]) => {
  const gate = fakeGate({ probe: [['[qa-layout] ready']], ...options })
  Object.assign(gate.ctx, { platform: 'android', appId: 'net.thunderbird.thunderbolt', appName: 'Thunderbolt' })
  return gate
}

// The home screen as the run 39373388149 session met it, cut down: a nameless root, and an icon named like our app.
const launcher = {
  ui_schema: { defaults: { txt: '', rid: '', a11y: '' } },
  elements: [
    {
      enabled: false,
      c: [
        { b: '[0,0][1080,136]', rid: 'com.android.systemui:id/status_bar' },
        {
          b: '[0,0][1080,2400]',
          rid: 'com.google.android.apps.nexuslauncher:id/launcher',
          c: [{ b: '[824,1873][997,2068]', a11y: 'Thunderbolt', txt: 'Thunderbolt' }],
        },
      ],
    },
  ],
}

test('on Android the app is in front when a view carries its package in the resource id', async () => {
  const { ctx, calls } = androidGate({ screen: 'inspect-android-onboarding' })
  const result = await handleCall('run', { yaml: '- tapOn: Skip' }, ctx)
  expect(calls.filter((call) => call.name === 'run')).toHaveLength(1)
  expect(text(result)).toEndWith('[qa-layout] ready keyboard=none')
})

test('on Android the home screen is not ours, though an icon there bears the app name', async () => {
  const { ctx, calls } = androidGate({
    respond: (call) => (call.name === 'inspect_screen' ? textResult(JSON.stringify(launcher)) : undefined),
  })
  const result = await handleCall('run', { yaml: '- tapOn: Skip' }, ctx)
  expect(calls.filter((call) => call.name === 'run')).toHaveLength(2)
  expect(text(result)).toContain('the app is still not in the foreground')
})

test('on Android the gate reads the keyboard from the tree and reports the focused field behind it', async () => {
  const wait = { yaml: '- waitForAnimationToEnd' }
  const open = await handleCall('run', wait, androidGate({ screen: 'hier-android-control' }).ctx)
  expect(text(open)).toEndWith('[qa-layout] ready keyboard=[0,1517][1080,2274]')

  const hierarchy = readFileSync(join(fixtureDir, 'hier-android-control.json'), 'utf8')
  const behind: HierarchyNode = JSON.parse(hierarchy.replace('[84,1131][1000,1281]', '[84,1700][1000,1850]'))
  const covered = JSON.stringify({ ui_schema: { defaults: {} }, elements: (behind.children ?? []).map(toInspect) })
  const { ctx } = androidGate({
    respond: (call) => (call.name === 'inspect_screen' ? textResult(covered) : undefined),
  })
  expect(text(await handleCall('run', wait, ctx))).toEndWith(
    '[qa-layout] ready keyboard=[0,1517][1080,2274]\n[qa-layout] behind-keyboard textbox "Email"',
  )
})

test("the tree's behind-keyboard line comes once per app launch, like the probe's lines", async () => {
  const hierarchy = readFileSync(join(fixtureDir, 'hier-android-control.json'), 'utf8')
  const behind: HierarchyNode = JSON.parse(hierarchy.replace('[84,1131][1000,1281]', '[84,1700][1000,1850]'))
  const covered = JSON.stringify({ ui_schema: { defaults: {} }, elements: (behind.children ?? []).map(toInspect) })
  const { ctx } = androidGate({
    probe: [['[qa-layout] ready'], [], ['[qa-layout] ready']],
    respond: (call) => (call.name === 'inspect_screen' ? textResult(covered) : undefined),
  })
  const line = '[qa-layout] behind-keyboard textbox "Email"'
  expect(text(await handleCall('run', { yaml: '- waitForAnimationToEnd' }, ctx))).toEndWith(line)
  expect(text(await handleCall('run', { yaml: '- waitForAnimationToEnd' }, ctx))).not.toContain(line)
  // A relaunch starts a new page, so the field behind the keyboard is news again.
  expect(text(await handleCall('run', { yaml: '- launchApp' }, ctx))).toEndWith(line)
})

test('a screen with unreadable bounds after a run keeps the run result and says so', async () => {
  const broken = {
    ui_schema: { defaults: {} },
    elements: [{ b: '[0,0][1080', rid: 'net.thunderbird.thunderbolt:id/x' }],
  }
  const { ctx } = androidGate({
    respond: (call) => (call.name === 'inspect_screen' ? textResult(JSON.stringify(broken)) : undefined),
  })
  const result = await handleCall('run', { yaml: '- tapOn: Hi' }, ctx)
  expect(result.isError).toBe(false)
  expect(text(result)).toBe('{"success":true}\n[qa-gate] could not read the screen after this run')
})

test('when the app stays in the background the result says so and measures nothing', async () => {
  const { ctx } = fakeGate({ screen: 'control-center', probe: [['[qa-layout] ready', nameBug]] })
  const result = await handleCall('run', { yaml: '- back' }, ctx)
  expect(text(result)).toContain('the app is still not in the foreground')
  expect(text(result)).not.toContain('[qa-layout]')
})

test('inspect_screen passes our device and carries the layout lines; cheat_sheet passes through', async () => {
  const { ctx, calls } = fakeGate({ screen: 'hier-name-kb' })
  appendFileSync(ctx.webviewLog, consoleLine('[qa-layout] ready') + consoleLine(nameBug))
  const screen = await handleCall('inspect_screen', {}, ctx)
  expect(calls[0]).toEqual({ name: 'inspect_screen', args: { device_id: ctx.deviceId } })
  expect(text(screen)).toContain('"Thunderbolt Dev"')
  expect(text(screen)).toEndWith(`[qa-layout] ready keyboard=[0,611][440,956]\n${nameBug}`)
  await handleCall('cheat_sheet', {}, ctx)
  expect(calls.at(-1)?.name).toBe('cheat_sheet')
})

test('a screenshot is saved in the session dir and the result names the file', async () => {
  const { ctx, dir } = fakeGate()
  const first = await handleCall('take_screenshot', {}, ctx)
  const second = await handleCall('take_screenshot', {}, ctx)
  expect(text(first)).toBe(`Saved to ${join(dir, 'maestro/shot-1.jpg')}`)
  expect(text(second)).toBe(`Saved to ${join(dir, 'maestro/shot-2.jpg')}`)
  expect(readFileSync(join(dir, 'maestro/shot-1.jpg'), 'utf8')).toBe('jpeg bytes')
  expect(first.content[0]).toMatchObject({ type: 'image' })
})

test('read_logs returns only new lines, only console and 5xx, sanitized', async () => {
  const { ctx } = fakeGate()
  writeFileSync(ctx.webviewLog, 'x [WebKit] CONSOLE LOG hello\nx unrelated system noise\n')
  // The backend's access log format.
  writeFileSync(
    ctx.backendLog,
    'INFO: - - "GET /v1/config HTTP/1.1" 200 OK 1ms\nINFO: - - "POST /v1/chat HTTP/1.1" 502 Bad Gateway 12ms\n',
  )
  const first = text(await handleCall('read_logs', {}, ctx))
  expect(first.split('\n')).toEqual([
    'webview: x [WebKit] CONSOLE LOG hello',
    'backend: INFO: - - "POST /v1/chat HTTP/1.1" 502 Bad Gateway 12ms',
  ])

  appendFileSync(ctx.webviewLog, 'x CONSOLE ERROR key sk-ant-api03-abcdefghijklmnop at https://evil.example/x\n')
  appendFileSync(ctx.webviewLog, 'x CONSOLE LOG half a line')
  const second = text(await handleCall('read_logs', {}, ctx))
  expect(second).toBe('webview: x CONSOLE ERROR key [secret removed] at [link removed]')

  appendFileSync(ctx.webviewLog, ', now whole\n')
  expect(text(await handleCall('read_logs', {}, ctx))).toBe('webview: x CONSOLE LOG half a line, now whole')
  expect(text(await handleCall('read_logs', {}, ctx))).toBe('no new log lines')
})

test('read_logs returns at most 200 lines, the newest', async () => {
  const { ctx } = fakeGate()
  writeFileSync(ctx.webviewLog, Array.from({ length: 250 }, (_, i) => `CONSOLE LOG ${i}\n`).join(''))
  const lines = text(await handleCall('read_logs', {}, ctx)).split('\n')
  expect(lines).toHaveLength(201)
  expect(lines[0]).toBe('[qa-gate] 50 older lines left out')
  expect(lines.at(-1)).toBe('webview: CONSOLE LOG 249')
})

test('a driver timeout is retried once', async () => {
  const { ctx, calls } = fakeGate({
    respond: (_call, index) =>
      index === 0
        ? textResult('iOS driver not ready in time, consider increasing timeout by configuring ...', true)
        : undefined,
  })
  const result = await handleCall('run', { yaml: '- back' }, ctx)
  expect(calls.map((call) => call.name)).toEqual(['run', 'run', 'inspect_screen'])
  expect(result.isError).toBe(false)
  expect(text(result)).not.toContain('not ready')
})
