#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The native explorer's only way to the device (spec 6.7, Ruling 1): an MCP server of ours between Claude and
// `maestro mcp`. It offers five tools, fixes the device, sends Maestro only flows that pass the allow list, brings
// the app back when a command leaves it, and after every run appends the layout probe's new `[qa-layout]` lines from
// the WebView log. The model never sees Maestro's cloud tools, its viewer or `list_devices`, because they are not
// forwarded.

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
import { measureNative, parseInspectScreen, readyLine } from '../native-layout'
import { sanitize, secretPattern } from './file-findings'
import { platformOf } from './findings'
import { checkMaestroFlow, maestroEnv } from './maestro-flow'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type ToolResult = { content: Content[]; isError?: boolean }
/** What the gate sends Maestro: the fixed device and, for `run`, its own serialization of the flow. */
type MaestroArgs = Record<string, string>
export type MaestroClient = { callTool: (name: string, args: MaestroArgs) => Promise<ToolResult> }
/** Tool arguments as the MCP SDK hands them over, after its own request parsing. */
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
  /**
   * How long the gate waits after a command for the layout probe's confirmed lines: the probe debounces 250 ms and
   * confirms over 500 ms. 1200 ms unless a test shortens it.
   */
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

/** The five tools the native explorer sees. None takes a device: the gate fixes it. */
export const gateTools = tools.map(({ name, description, args }) => ({
  name,
  description,
  inputSchema: z.toJSONSchema(args),
}))

const driverTimeout = 'iOS driver not ready in time'
const consoleMark = { ios: 'CONSOLE', android: 'Tauri/Console' }
const secrets = new RegExp(secretPattern.source, 'g')
const logOffsets = new Map<string, number>()
// The WebView logs whose probe has said ready since the app last started. One gate process serves one session.
const probeSeen = new Set<string>()

const log = (ctx: GateContext, line: string) => appendFileSync(ctx.gateLog, `${line}\n`)

const textOf = (result: ToolResult) =>
  result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')

const reply = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], isError })

const withLines = (result: ToolResult, lines: string[]): ToolResult => ({
  ...result,
  content: [...result.content, { type: 'text', text: lines.join('\n') }],
})

/** One Maestro call, repeated once when its XCTest driver did not start in time (spike, decision 1). */
const callMaestro = async (ctx: GateContext, name: string, args: MaestroArgs) => {
  const result = await ctx.client.callTool(name, args)
  return textOf(result).includes(driverTimeout) ? ctx.client.callTool(name, args) : result
}

const inspect = (ctx: GateContext) => callMaestro(ctx, 'inspect_screen', { device_id: ctx.deviceId })

const screenSchema = z.object({ elements: z.array(z.object({ a11y: z.string().optional() })) })

/**
 * Whose screen Maestro showed. The top element is the foreground app; under the Control Center it is blank (spike,
 * decision 4). A reply that is not a screen (an error, a second driver timeout) is `unreadable`.
 */
const whoseScreen = (screen: ToolResult, ctx: GateContext): 'ours' | 'away' | 'unreadable' => {
  try {
    const tree = screenSchema.safeParse(JSON.parse(textOf(screen))).data
    if (!tree) return 'unreadable'
    return tree.elements[0]?.a11y === ctx.appName ? 'ours' : 'away'
  } catch {
    return 'unreadable'
  }
}

/** The screen once our app is in front: as it is, or after the harness pressed Home and reopened the app. */
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
const clean = (line: string) => sanitize(line.replace(secrets, '[secret removed]'), 500)

const probeReady = '[qa-layout] ready'

/**
 * The layout after a command: the probe's new `[qa-layout]` lines from the WebView log, after a wait for its
 * confirmation, under the gate's ready line with the keyboard from the tree. The ready line needs the probe's own
 * ready line since the app last started, so a build without the probe never looks clean. A foreign screen is never
 * measured.
 */
const measured = async (ctx: GateContext, restarted = false) => {
  if (restarted) probeSeen.delete(ctx.webviewLog)
  await Bun.sleep(ctx.probeWaitMs ?? 1200)
  const { screen, notes } = await foregroundScreen(ctx)
  const whose = whoseScreen(screen, ctx)
  // A flow that already ran must not look failed, or the model runs it again.
  if (whose === 'unreadable') return { screen, lines: [...notes, '[qa-gate] could not read the screen after this run'] }
  if (whose === 'away') {
    return { screen, lines: [...notes, '[qa-gate] the app is still not in the foreground; nothing measured'] }
  }
  const probe = newLines(ctx.webviewLog, 'layout')
    .filter((line) => line.includes('[qa-layout]'))
    .map((line) => clean(line.slice(line.indexOf('[qa-layout]'))))
  if (probe.includes(probeReady)) probeSeen.add(ctx.webviewLog)
  const head = probeSeen.has(ctx.webviewLog)
    ? readyLine(measureNative(parseInspectScreen(textOf(screen)), ctx.platform))
    : '[qa-gate] layout probe not seen since launch'
  return { screen, lines: [...notes, head, ...probe.filter((line) => line !== probeReady)] }
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

/**
 * The whole lines appended to `file` since this reader's last call; a line still being written waits for the next
 * one. `read_logs` and the layout reader keep separate offsets, so neither takes the other's lines.
 */
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

/**
 * Handles one tool call from the explorer. A tool the gate does not offer, or an argument its schema does not
 * declare (`device_id`, `files`, `dir`, `env`), is refused and logged without reaching Maestro.
 */
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
