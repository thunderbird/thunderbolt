#!/usr/bin/env bun

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The PreToolUse hook of a native explore session on macOS. Any process of the job user can read the
// Anthropic key there, so the model may only call the gated Maestro tools, the second browser when the harness
// allows it, and Write or Edit inside the session folder. Claude Code runs it as
// `bun <abs>/.github/qa/scripts/native-hook.ts || exit 2`: the hook fails open when it cannot run, so a crash must
// still exit 2.

import { appendFileSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { z } from 'zod'

const hookInputSchema = z.object({ tool_name: z.string(), tool_input: z.record(z.string(), z.unknown()) })
const writeInputSchema = z.object({ file_path: z.string() })

export type HookInput = z.infer<typeof hookInputSchema>
export type HookDecision = { allow: boolean; reason: string }

const maestroTools = ['run', 'inspect_screen', 'take_screenshot', 'cheat_sheet', 'read_logs']

/**
 * A path that does not exist yet resolves through its nearest existing ancestor; an entry that exists but cannot be
 * resolved (a link to a missing target) throws, because a write would follow it.
 */
const realTarget = (path: string): string => {
  try {
    return realpathSync(path)
  } catch (error) {
    if (lstatSync(path, { throwIfNoEntry: false })) throw error
    return resolve(realTarget(dirname(path)), basename(path))
  }
}

const writeDecision = (toolInput: HookInput['tool_input'], sessionDir: string): HookDecision => {
  const parsed = writeInputSchema.safeParse(toolInput)
  if (!parsed.success) return { allow: false, reason: 'file_path is missing' }
  const filePath = parsed.data.file_path
  try {
    const target = realTarget(resolve(filePath))
    return target.startsWith(realTarget(sessionDir) + sep)
      ? { allow: true, reason: 'inside the session dir' }
      : { allow: false, reason: `${target} is outside the session dir` }
  } catch (error) {
    return { allow: false, reason: `cannot resolve ${filePath}: ${String(error)}` }
  }
}

export const hookDecision = (input: HookInput, sessionDir: string, allowBrowserB: boolean): HookDecision => {
  const tool = input.tool_name
  if (maestroTools.some((name) => tool === `mcp__maestro__${name}`))
    return { allow: true, reason: 'gated Maestro tool' }
  if (tool.startsWith('mcp__playwright_b__')) {
    if (!allowBrowserB) return { allow: false, reason: 'the second browser is off for this session' }
    if (tool === 'mcp__playwright_b__browser_run_code_unsafe') return { allow: false, reason: 'runs arbitrary code' }
    return { allow: true, reason: 'second browser' }
  }
  if (tool === 'Write' || tool === 'Edit') return writeDecision(input.tool_input, sessionDir)
  // It only loads the schemas of tools the session already has, and Claude Code may defer the Maestro tools behind it.
  if (tool === 'ToolSearch') return { allow: true, reason: 'loads tool schemas' }
  return { allow: false, reason: 'not allowed in a native session' }
}

if (import.meta.main) {
  const sessionDir = process.env.QA_SESSION_DIR
  const gateLog = process.env.QA_GATE_LOG
  if (!sessionDir || !gateLog) throw new Error('QA_SESSION_DIR and QA_GATE_LOG must be set')
  const input = hookInputSchema.parse(JSON.parse(await Bun.stdin.text()))
  const decision = hookDecision(input, sessionDir, process.env.QA_ALLOW_BROWSER_B === '1')
  appendFileSync(gateLog, `${decision.allow ? 'allow' : 'deny'} ${input.tool_name} ${decision.reason}\n`)
  if (!decision.allow) {
    // Claude Code shows the model the stderr of a hook that exits 2.
    console.error(decision.reason)
    process.exit(2)
  }
}
