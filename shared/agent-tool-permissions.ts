/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

type AcpPermissionOption = {
  optionId: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

type AcpRequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string }

/** Whether a Pi tool is deterministic and side-effect free. */
export const isReadOnlyAgentTool = (toolName: string): boolean => toolName === 'read'

/** Map a Pi coding-tool name to its closest ACP presentation kind. */
export const toAcpToolKind = (toolName: string): AcpToolKind => {
  switch (toolName) {
    case 'bash':
      return 'execute'
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    default:
      return 'other'
  }
}

export type ToolPermissionDecision = 'allow-once' | 'allow-always' | 'reject'

/** Resolve ACP permission output through option kinds, keeping callers
 * independent from their chosen option ids and rejecting unknown selections. */
export const resolveToolPermission = (
  outcome: AcpRequestPermissionOutcome,
  options: readonly AcpPermissionOption[],
): ToolPermissionDecision => {
  if (outcome.outcome === 'cancelled') return 'reject'
  const selected = options.find((option) => option.optionId === outcome.optionId)
  if (selected?.kind === 'allow_always') return 'allow-always'
  if (selected?.kind === 'allow_once') return 'allow-once'
  return 'reject'
}
