/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isReadOnlyAgentTool } from '../../../shared/agent-tool-permissions.ts'
import type { HarnessRuntime, ProviderManagerIO, ProviderManagerItem } from '../provider-runtime/types.ts'
import { sanitizePermissionText } from '../ui/render.ts'
import type { PermissionPrompt, PermissionRequest } from './types.ts'

export const permissionModeCycle = ['ask', 'accept-edits', 'read-only', 'yolo'] as const

export type PermissionMode = (typeof permissionModeCycle)[number]

export const permissionModeItems = [
  { id: 'ask', label: 'Ask', description: 'Prompt before bash, write, and edit' },
  { id: 'accept-edits', label: 'Accept edits', description: 'Allow write and edit; ask before bash' },
  { id: 'read-only', label: 'Read only', description: 'Block bash, write, and edit' },
  { id: 'yolo', label: 'Yolo', description: 'Allow every tool call' },
] as const satisfies readonly (ProviderManagerItem & { readonly id: PermissionMode })[]

export const readOnlyBlockReason = 'blocked: read-only mode — propose the change instead of applying it'

/** Advances to the next permission mode. */
export const cyclePermissionMode = (mode: PermissionMode): PermissionMode =>
  permissionModeCycle[(permissionModeCycle.indexOf(mode) + 1) % permissionModeCycle.length]!

/** Opens the shared manager picker and returns the selected permission mode. */
export const choosePermissionMode = async (
  io: ProviderManagerIO,
  currentMode: PermissionMode,
): Promise<PermissionMode> => {
  const selected = await io.choose('Permissions', permissionModeItems)
  return permissionModeCycle.find((mode) => mode === selected) ?? currentMode
}

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
 * The current mode is read for every tool call so interactive changes apply
 * immediately. In `ask`, write/edit/bash calls use {@link PermissionPrompt}:
 * `allow-once` runs it, `allow-session` runs it and allows that tool for the
 * rest of the session, and `deny` blocks it with an error tool result. Read-only
 * tools are always allowed.
 *
 * @param target - the narrow runtime gate registration surface
 * @param opts.getMode - returns the live permission mode
 * @param opts.ask - prompt used to ask the user for a decision
 */
export const attachPermissionGate = (
  target: Pick<HarnessRuntime, 'registerToolCallGate'>,
  opts: { getMode: () => PermissionMode; ask: PermissionPrompt },
): void => {
  const sessionAllowed = new Set<string>()

  target.registerToolCallGate(async ({ toolName, input }) => {
    if (isReadOnlyAgentTool(toolName) || toolName === 'webfetch') return undefined

    const mode = opts.getMode()
    if (mode === 'yolo') return undefined
    if (mode === 'read-only') return { block: true, reason: readOnlyBlockReason }
    if (mode === 'accept-edits' && (toolName === 'write' || toolName === 'edit')) return undefined
    if (mode === 'ask' && sessionAllowed.has(toolName)) return undefined

    const request: PermissionRequest = { toolName, summary: summarize(toolName, input) }
    const decision = await opts.ask(request)
    if (decision === 'allow-once') return undefined
    if (decision === 'allow-session') {
      if (mode === 'ask') sessionAllowed.add(toolName)
      return undefined
    }
    return { block: true, reason: `User denied ${toolName}` }
  })
}
