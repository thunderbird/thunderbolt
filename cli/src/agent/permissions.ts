/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentHarness } from '@earendil-works/pi-agent-core'
import { isReadOnlyAgentTool } from '../../../shared/agent-tool-permissions.ts'
import { sanitizePermissionText } from '../ui/render.ts'
import type { PermissionPrompt, PermissionRequest } from './types.ts'

/**
 * Builds the one-line summary shown to the user for a gated tool call. `bash`
 * summarizes to its command; `write`/`edit` to their target path (both tools
 * use an `input.path` field).
 *
 * @param toolName - the tool being invoked
 * @param input - the tool's validated arguments
 * @returns a human-readable one-liner
 */
const summarize = (toolName: string, input: Record<string, unknown>): string => {
  if (toolName === 'bash' && typeof input.command === 'string') return sanitizePermissionText(input.command)
  if (typeof input.path === 'string') return sanitizePermissionText(input.path)
  return sanitizePermissionText(JSON.stringify(input))
}

/**
 * Registers the interactive tool-permission gate on the harness.
 *
 * In `yolo` mode no hook is attached and every tool call runs unguarded.
 * Otherwise each write/edit/bash call is approved via {@link PermissionPrompt}:
 * `allow-once` runs it, `allow-session` runs it and allows that tool for the
 * rest of the session, and `deny` blocks it with an error tool result. Read-only
 * tools are always allowed.
 *
 * @param harness - the Pi harness to gate
 * @param opts.yolo - when true, auto-approve everything (no gate)
 * @param opts.ask - prompt used to ask the user for a decision
 */
export const attachPermissionGate = (harness: AgentHarness, opts: { yolo: boolean; ask: PermissionPrompt }): void => {
  if (opts.yolo) return

  const sessionAllowed = new Set<string>()

  harness.on('tool_call', async ({ toolName, input }) => {
    if (isReadOnlyAgentTool(toolName) || toolName === 'webfetch' || sessionAllowed.has(toolName)) return undefined

    const request: PermissionRequest = { toolName, summary: summarize(toolName, input) }
    const decision = await opts.ask(request)
    if (decision === 'allow-once') return undefined
    if (decision === 'allow-session') {
      sessionAllowed.add(toolName)
      return undefined
    }
    return { block: true, reason: `User denied ${toolName}` }
  })
}
