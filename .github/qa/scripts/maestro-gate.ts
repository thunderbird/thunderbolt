#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The native explorer's only way to the device: an MCP server between Claude and `maestro mcp`. Maestro's cloud
// tools, its viewer and `list_devices` are not forwarded, so the model never sees them.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { keepsProbeLine, measureNative, parseInspectScreen, readyLine } from '../native-layout'
import { platformOf } from './findings'
import { checkMaestroFlow, maestroEnv } from './maestro-flow'
import { cleanLogLine } from './sanitize'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type ToolResult = { content: Content[]; isError?: boolean }
type MaestroArgs = Record<string, string>
export type MaestroClient = { callTool: (name: string, args: MaestroArgs) => Promise<ToolResult> }
type CallArgs = NonNullable<CallToolRequest['params']['arguments']>
export type GateContext = {
  client: MaestroClient
  platform: 'ios' | 'android'
  deviceId: string
  appId: string
  appName: string
  sessionDir: string
  webviewLog: string
  backendLog: string
  gateLog: string
  /** The probe debounces 250 ms and confirms over 500 ms; the default wait is 1200 ms. */
  probeWaitMs?: number
}

const runArgs = z.strictObject({
  yaml: z.string().describe('Inline Maestro flow YAML, for example `- tapOn: Continue`'),
})
const noArgs = z.strictObject({})

// Each tool's arguments are a strict schema, so `device_id`, `files`, `dir` or `env` never reach Maestro.
const tools = [
  {
    name: 'run',
    description:
      'Runs Maestro commands on the app under test. Pass only `yaml`: a list of commands, optionally after an ' +
      '`appId` header and `---`. Commands outside the QA allow list (scripts, links, media, device settings, ' +
      'other apps) are refused. Nothing may leave the app mid-flow: swipe points are percentages and a swipe may ' +
      'not start within 5% of a screen edge, stopApp and killApp must be followed by launchApp, and back may ' +
      'only be the last command. The result ends with `[qa-layout]` lines: the ready line with the keyboard, then ' +
      'each layout problem the in-app probe confirmed since the last call (a problem is reported once per app ' +
      'launch).',
    args: runArgs,
  },
  {
    name: 'inspect_screen',
    description:
      "The current screen's view hierarchy as compact JSON, followed by the `[qa-layout]` lines. Keys are " +
      'abbreviated (`b` bounds, `txt` text, `rid` resource-id, `a11y` accessibilityText, `hint`, `val`, `c` ' +
      'children). In selectors use `text:` for `txt` or `a11y` values, copied verbatim: Maestro matches the full ' +
      'string as a case-insensitive regex.',
    args: noArgs,
  },
  {
    name: 'take_screenshot',
    description: 'A screenshot of the device. The image is saved in the session folder and the result names the file.',
    args: noArgs,
  },
  {
    name: 'cheat_sheet',
    description: "Maestro's cheat sheet of commands and syntax. `run` refuses some of the commands it lists.",
    args: noArgs,
  },
  {
    name: 'read_logs',
    description:
      "The log lines written since the last call: the app WebView's console (without the `[qa-layout]` lines, " +
      "which come with run and inspect_screen) and the backend's 5xx responses, " +
      'with secrets removed. At most 200 lines, the newest.',
    args: noArgs,
  },
]

export const gateTools = tools.map(({ name, description, args }) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(args),
}))

const driverTimeout = 'iOS driver not ready in time'
const consoleMark = { ios: 'CONSOLE', android: 'Tauri/Console' }
const logOffsets = new Map<string, number>()
// Both reset when the app restarts: the probe and the tree report each line once per launch.
const probeSeen = new Set<string>()
const treeSent = new Map<string, Set<string>>()

const log = (ctx: GateContext, line: string) => appendFileSync(ctx.gateLog, `${line}\n`)

const textOf = (result: ToolResult) =>
  result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')

const reply = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], isError })

const withLines = (result: ToolResult, lines: string[]): ToolResult => ({
  ...result,
  content: [...result.content, { type: 'text', text: lines.join('\n') }],
})

/** Retries once: the XCTest driver sometimes does not start in time. */
const callMaestro = async (ctx: GateContext, name: string, args: MaestroArgs) => {
  const result = await ctx.client.callTool(name, args)
  return textOf(result).includes(driverTimeout) ? ctx.client.callTool(name, args) : result
}

const inspect = (ctx: GateContext) => callMaestro(ctx, 'inspect_screen', { device_id: ctx.deviceId })

type ScreenElement = { a11y?: string; txt?: string; rid?: string; c?: ScreenElement[] }
const elementSchema: z.ZodType<ScreenElement> = z.object({
  a11y: z.string().optional(),
  txt: z.string().optional(),
  rid: z.string().optional(),
  c: z.lazy(() => z.array(elementSchema)).optional(),
})
const screenSchema = z.object({ elements: z.array(elementSchema) })

const elementsOf = (element: ScreenElement): ScreenElement[] => [element, ...(element.c ?? []).flatMap(elementsOf)]

/**
 * Whose screen Maestro showed. On iOS the top element is the foreground app, named in `a11y`, and under the Control
 * Center it is blank. The Android top element has no name; there the app's own views carry its
 * package in their resource ids (`<appId>:id/action_bar_root`), which a launcher icon does not. A reply
 * that is not a screen (an error, a second driver timeout) is `unreadable`.
 */
const whoseScreen = (screen: ToolResult, ctx: GateContext): 'ours' | 'away' | 'unreadable' => {
  try {
    const tree = screenSchema.safeParse(JSON.parse(textOf(screen))).data
    if (!tree) return 'unreadable'
    const root = tree.elements[0]
    const named = root !== undefined && (root.a11y === ctx.appName || root.txt === ctx.appName)
    const ownView = tree.elements.flatMap(elementsOf).some((element) => element.rid?.startsWith(`${ctx.appId}:id/`))
    return named || ownView ? 'ours' : 'away'
  } catch {
    return 'unreadable'
  }
}

const foregroundScreen = async (ctx: GateContext) => {
  const screen = await inspect(ctx)
  if (whoseScreen(screen, ctx) !== 'away') return { screen, notes: [] }
  // pressKey Home is refused to the agent; the harness sends its own flow, outside the allow list.
  const reopen = `appId: ${ctx.appId}\n---\n- pressKey: Home\n- launchApp:\n    stopApp: false\n`
  await callMaestro(ctx, 'run', { device_id: ctx.deviceId, yaml: reopen })
  return { screen: await inspect(ctx), notes: ['[qa-gate] the app left the foreground; the harness reopened it'] }
}

/**
 * Whether a flow the gate wrote restarts the app, and with it the page and its probe: `stopApp`, `killApp`, or a
 * `launchApp` without `stopApp: false`. It reads the gate's own `Bun.YAML.stringify` output, where a command's options
 * sit four spaces deeper than its `- `.
 */
export const restartsApp = (yaml: string) =>
  /^ *- (stopApp|killApp)\b/m.test(yaml) ||
  [...yaml.matchAll(/^( *)- launchApp:?[ \t]*(.*)$((?:\n\1 {4}.*)*)/gm)].some(
    ([, , value, options]) => value !== '' || !/^ *stopApp: false$/m.test(options),
  )

// 200 lines of 500 characters stay under Claude Code's MCP output limit.
const clean = (line: string) => cleanLogLine(line).slice(0, 500)

const probeReady = '[qa-layout] ready'

const measureScreen = (screen: ToolResult, ctx: GateContext) => {
  try {
    return measureNative(parseInspectScreen(textOf(screen)), ctx.platform)
  } catch {
    return undefined
  }
}

/**
 * The ready line needs the probe's own ready line since the app last started, so a build without the probe never
 * looks clean. A foreign screen is never measured.
 */
const measured = async (ctx: GateContext, restarted = false) => {
  if (restarted) {
    probeSeen.delete(ctx.webviewLog)
    treeSent.delete(ctx.webviewLog)
  }
  await Bun.sleep(ctx.probeWaitMs ?? 1200)
  const { screen, notes } = await foregroundScreen(ctx)
  const whose = whoseScreen(screen, ctx)
  // A flow that already ran must not look failed, or the model runs it again.
  const unreadable = { screen, lines: [...notes, '[qa-gate] could not read the screen after this run'] }
  if (whose === 'unreadable') return unreadable
  if (whose === 'away') {
    return { screen, lines: [...notes, '[qa-gate] the app is still not in the foreground; nothing measured'] }
  }
  // Before the log is read, so an unreadable screen leaves the probe's lines for the next call.
  const measure = measureScreen(screen, ctx)
  if (!measure) return unreadable
  const probe = newLines(ctx.webviewLog, 'layout')
    .filter((line) => line.includes('[qa-layout]'))
    .map((line) => clean(line.slice(line.indexOf('[qa-layout]'))))
    .filter((line) => keepsProbeLine(line, ctx.platform))
  if (probe.includes(probeReady)) probeSeen.add(ctx.webviewLog)
  const sent = treeSent.get(ctx.webviewLog) ?? new Set<string>()
  treeSent.set(ctx.webviewLog, sent)
  const tree = measure.problems.map(clean).filter((line) => !sent.has(line))
  for (const line of tree) sent.add(line)
  const head = probeSeen.has(ctx.webviewLog) ? readyLine(measure) : '[qa-gate] layout probe not seen since launch'
  return { screen, lines: [...notes, head, ...tree, ...probe.filter((line) => line !== probeReady)] }
}

const run = async (yaml: string, ctx: GateContext) => {
  const check = checkMaestroFlow(yaml, { appId: ctx.appId })
  if (!check.ok) {
    log(ctx, `deny run ${check.problems.join('; ')}`)
    return reply(`denied: ${check.problems.join('; ')}`, true)
  }
  log(ctx, 'allow run')
  const result = await callMaestro(ctx, 'run', { device_id: ctx.deviceId, yaml: check.yaml })
  return withLines(result, (await measured(ctx, restartsApp(check.yaml))).lines)
}

const screenshot = async (ctx: GateContext) => {
  const result = await callMaestro(ctx, 'take_screenshot', { device_id: ctx.deviceId })
  const image = result.content.find((item) => item.type === 'image')
  if (!image) return result
  const dir = join(ctx.sessionDir, 'maestro')
  mkdirSync(dir, { recursive: true })
  // Maestro 2.11 on iOS sends JPEG, so the name follows the image's type.
  const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png'
  const shots = readdirSync(dir).filter((name) => /^shot-\d+\.(png|jpg)$/.test(name)).length
  const file = join(dir, `shot-${shots + 1}.${extension}`)
  writeFileSync(file, Buffer.from(image.data, 'base64'))
  return withLines(result, [`Saved to ${file}`])
}

/** A line still being written waits for the next call. `read_logs` and the layout reader keep separate offsets. */
const newLines = (file: string, reader: 'logs' | 'layout'): string[] => {
  if (!existsSync(file)) return []
  const bytes = readFileSync(file)
  const key = `${reader} ${file}`
  const start = logOffsets.get(key) ?? 0
  const end = bytes.lastIndexOf('\n') + 1
  if (end <= start) return []
  logOffsets.set(key, end)
  return bytes.subarray(start, end).toString('utf8').split('\n').slice(0, -1)
}

const readLogs = (ctx: GateContext) => {
  const lines = [
    ...newLines(ctx.webviewLog, 'logs')
      // The probe's own lines reach the model only through run and inspect_screen, so nothing counts them twice.
      .filter((line) => line.includes(consoleMark[ctx.platform]) && !line.includes('[qa-layout]'))
      .map((line) => `webview: ${line}`),
    ...newLines(ctx.backendLog, 'logs')
      .filter((line) => / 5\d\d /.test(line))
      .map((line) => `backend: ${line}`),
  ].map(clean)
  const kept = lines.slice(-200)
  const left = lines.length - kept.length
  const notes = left > 0 ? [`[qa-gate] ${left} older lines left out`] : []
  return reply(kept.length > 0 ? [...notes, ...kept].join('\n') : 'no new log lines')
}

/** A tool the gate does not offer, or an argument its schema does not declare, is refused without reaching Maestro. */
export const handleCall = async (name: string, args: CallArgs, ctx: GateContext): Promise<ToolResult> => {
  const tool = tools.find((entry) => entry.name === name)
  if (!tool) {
    log(ctx, `deny ${name} unknown tool`)
    return reply(`denied: ${name} is not a tool of this session`, true)
  }
  const parsed = tool.args.safeParse(args)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    log(ctx, `deny ${name} ${problems.join('; ')}`)
    return reply(`denied: ${problems.join('; ')}`, true)
  }
  if ('yaml' in parsed.data) return run(parsed.data.yaml, ctx)
  log(ctx, `allow ${name}`)
  if (name === 'inspect_screen') {
    const { screen, lines } = await measured(ctx)
    return withLines(screen, lines)
  }
  if (name === 'take_screenshot') return screenshot(ctx)
  if (name === 'read_logs') return readLogs(ctx)
  return callMaestro(ctx, 'cheat_sheet', {})
}

const required = (key: string) => {
  const value = process.env[key]
  if (!value) throw new Error(`${key} must be set`)
  return value
}

/** Maestro's text and images; it sends no other content. */
const toContent = (item: CallToolResult['content'][number]): Content[] => {
  if (item.type === 'text') return [{ type: 'text', text: item.text }]
  if (item.type === 'image') return [{ type: 'image', data: item.data, mimeType: item.mimeType }]
  return []
}

if (import.meta.main) {
  const platform = required('QA_PLATFORM')
  if (platform !== 'ios' && platform !== 'android') throw new Error(`QA_PLATFORM must be ios or android: ${platform}`)
  const { appId, appName } = platformOf(platform)
  if (!appId || !appName) throw new Error(`platforms.json has no app for ${platform}`)

  const maestro = new Client({ name: 'qa-maestro-gate', version: '1.0.0' })
  await maestro.connect(
    new StdioClientTransport({ command: 'maestro', args: ['mcp', '--no-viewer'], env: maestroEnv() }),
  )
  const ctx: GateContext = {
    client: {
      callTool: async (name, args) => {
        // The SDK's 60 s default is shorter than a cold XCTest driver start (MAESTRO_DRIVER_STARTUP_TIMEOUT).
        const result = CallToolResultSchema.parse(
          await maestro.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 300_000 }),
        )
        return { content: result.content.flatMap(toContent), isError: result.isError }
      },
    },
    platform,
    deviceId: required('QA_DEVICE_ID'),
    appId,
    appName,
    sessionDir: required('QA_SESSION_DIR'),
    webviewLog: required('QA_WEBVIEW_LOG'),
    backendLog: required('QA_BACKEND_LOG'),
    gateLog: required('QA_GATE_LOG'),
  }

  const server = new Server({ name: 'maestro', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: gateTools }))
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => handleCall(params.name, params.arguments ?? {}, ctx))
  server.onclose = () => void maestro.close()
  await server.connect(new StdioServerTransport())
}
