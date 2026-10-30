#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The native canary: it takes the place of `claude` in explore.sh's native_claude and makes the two forbidden calls
// itself, so no model decides whether the gate gets tested. It reads the session's own hook command from
// $CLAUDE_CONFIG_DIR/settings.json and its gate from the --mcp-config files, runs the hook the way Claude Code does
// (JSON on stdin, only exit code 2 blocks), and calls the gate over MCP stdio. It writes nothing to the gate log and
// decides nothing: explore.sh reads the hook's and the gate's own log lines and checks that the file is absent.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { writeFileSync } from 'node:fs'
import { z } from 'zod'

const settingsSchema = z.object({
  hooks: z.object({ PreToolUse: z.tuple([z.object({ hooks: z.tuple([z.object({ command: z.string() })]) })]) }),
})
const mcpSchema = z.object({
  mcpServers: z.object({ maestro: z.object({ command: z.string(), args: z.array(z.string()) }) }),
})

/** Claude Code lets a call through unless its hook exits 2. */
const hookAllows = (command: string, toolName: string, toolInput: Record<string, string>) =>
  Bun.spawnSync(['sh', '-c', command], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }),
    ),
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode !== 2

const required = (key: string) => {
  const value = process.env[key]
  if (!value) throw new Error(`${key} must be set`)
  return value
}

// The gate may wait on a Maestro that never starts.
setTimeout(() => {
  console.error('the canary timed out')
  process.exit(1)
}, 120_000).unref()

const settings = settingsSchema.parse(await Bun.file(`${required('CLAUDE_CONFIG_DIR')}/settings.json`).json())
const hook = settings.hooks.PreToolUse[0].hooks[0].command
const outside = required('QA_CANARY_OUTSIDE')
const yaml = '- runScript: canary.js'

// A hook that lets the write through lets it happen, as it would in a session.
if (hookAllows(hook, 'Write', { file_path: outside, content: 'canary' })) writeFileSync(outside, 'canary')

// The gate is in the first config file; the second device's browser, when there is one, comes after it.
const gate = mcpSchema.parse(await Bun.file(process.argv[process.argv.indexOf('--mcp-config') + 1]).json()).mcpServers
  .maestro

if (hookAllows(hook, 'mcp__maestro__run', { yaml })) {
  const client = new Client({ name: 'qa-canary', version: '1.0.0' })
  const env = z.record(z.string(), z.string()).parse(process.env)
  await client.connect(new StdioClientTransport({ command: gate.command, args: gate.args, env }))
  await client.callTool({ name: 'run', arguments: { yaml } })
  await client.close()
}
