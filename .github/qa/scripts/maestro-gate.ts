#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The native explorer's only way to the device (spec 6.7, Ruling 1): an MCP server of ours between Claude and
// `maestro mcp`. It offers five tools, fixes the device, sends Maestro only flows that pass the allow list, brings
// the app back when a command leaves it, and measures the layout after every run. The model never sees Maestro's
// cloud tools, its viewer or `list_devices`, because they are not forwarded.

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
import { type LayoutProblem } from '../layout'
import { layoutLines, measureNative, parseInspectScreen } from '../native-layout'
import { sanitize, secretPattern } from './file-findings'
import { platformOf } from './findings'
import { checkMaestroFlow } from './maestro-flow'

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
  /** The wait between the two screen readings a measurement compares; 500 ms unless a test shortens it. */
  settleMs?: number
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
      'other apps) are refused. The result ends with `[qa-layout]` lines: the layout measured on the screen the ' +
      'commands left.',
    args: runArgs,
  },
  {
    name: 'inspect_screen',
    description:
      "The current screen's view hierarchy as compact JSON, followed by its `[qa-layout]` lines. Keys are " +
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
      "The log lines written since the last call: the app WebView's console and the backend's 5xx responses, " +
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

// The top element is the foreground app; under the Control Center it is blank (spike, decision 4).
const isOurs = (screen: ToolResult, ctx: GateContext) => {
  const tree: { elements: { a11y?: string }[] } = JSON.parse(textOf(screen))
  return tree.elements[0]?.a11y === ctx.appName
}

/** The screen once our app is in front: as it is, or after the harness pressed Home and reopened the app. */
const foregroundScreen = async (ctx: GateContext) => {
  const screen = await inspect(ctx)
  if (isOurs(screen, ctx)) return { screen, notes: [] }
  // pressKey Home is refused to the agent; the harness sends its own flow, outside the allow list.
  const reopen = `appId: ${ctx.appId}\n---\n- pressKey: Home\n- launchApp:\n    stopApp: false\n`
  await callMaestro(ctx, 'run', { device_id: ctx.deviceId, yaml: reopen })
  return { screen: await inspect(ctx), notes: ['[qa-gate] the app left the foreground; the harness reopened it'] }
}

const problemKey = ({ kind, target }: LayoutProblem) => `${kind} ${target}`

/**
 * Measures the screen the way the web probe confirms a problem: two readings `settleMs` apart, keeping only the
 * problems both show, because the keyboard animates in after a field takes focus. A foreign screen is never measured.
 */
const measured = async (ctx: GateContext) => {
  const { screen, notes } = await foregroundScreen(ctx)
  const stillAway = { screen, lines: [...notes, '[qa-gate] the app is still not in the foreground; nothing measured'] }
  if (!isOurs(screen, ctx)) return stillAway
  await Bun.sleep(ctx.settleMs ?? 500)
  const again = await inspect(ctx)
  if (!isOurs(again, ctx)) return { ...stillAway, screen: again }
  const first = new Set(measureNative(parseInspectScreen(textOf(screen)), ctx.platform).problems.map(problemKey))
  const second = measureNative(parseInspectScreen(textOf(again)), ctx.platform)
  const problems = second.problems.filter((problem) => first.has(problemKey(problem)))
  return { screen: again, lines: [...notes, ...layoutLines({ keyboard: second.keyboard, problems })] }
}

const run = async (yaml: string, ctx: GateContext) => {
  const check = checkMaestroFlow(yaml, { appId: ctx.appId })
  if (!check.ok) {
    log(ctx, `deny run ${check.problems.join('; ')}`)
    return reply(`denied: ${check.problems.join('; ')}`, true)
  }
  log(ctx, 'allow run')
  const result = await callMaestro(ctx, 'run', { device_id: ctx.deviceId, yaml: check.yaml })
  return withLines(result, (await measured(ctx)).lines)
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

/** The whole lines appended to `file` since the last call; a line still being written waits for the next one. */
const newLines = (file: string): string[] => {
  if (!existsSync(file)) return []
  const bytes = readFileSync(file)
  const start = logOffsets.get(file) ?? 0
  const end = bytes.lastIndexOf('\n') + 1
  if (end <= start) return []
  logOffsets.set(file, end)
  return bytes.subarray(start, end).toString('utf8').split('\n').slice(0, -1)
}

const readLogs = (ctx: GateContext) => {
  const lines = [
    ...newLines(ctx.webviewLog)
      .filter((line) => line.includes(consoleMark[ctx.platform]))
      .map((line) => `webview: ${line}`),
    ...newLines(ctx.backendLog)
      .filter((line) => / 5\d\d /.test(line))
      .map((line) => `backend: ${line}`),
  ].map((line) => sanitize(line.replace(secrets, '[secret removed]'), 2000))
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

/** The environment `maestro mcp` starts with: the SDK adds HOME, LOGNAME, PATH, SHELL, TERM and USER. */
const maestroEnv = () => ({
  ...Object.fromEntries(
    ['JAVA_HOME', 'ANDROID_HOME'].flatMap((key) => {
      const value = process.env[key]
      return value ? [[key, value]] : []
    }),
  ),
  MAESTRO_CLI_NO_ANALYTICS: '1',
  MAESTRO_DRIVER_STARTUP_TIMEOUT: '180000',
})

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
