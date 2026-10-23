/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { AgentAdapterContext } from '@/types/acp'
import type { AgentExecution } from './store'
import type { Tool } from 'ai'
import { toAcpToolKind } from '@shared/agent-tool-permissions'

export type ApprovalTool = { name: string; source: 'built-in' | 'external' }
export type AuthorizeTool = (tool: ApprovalTool, input: unknown, id: string, signal?: AbortSignal) => Promise<void>

// Only audited read-only tools bypass approval. Unknown integration/MCP actions ask.
const readOnlyTools = new Set([
  'read',
  'search',
  'fetch_content',
  'search_project_chats',
  'get_app_context',
  'skill',
  'getTasks',
  'google_check_inbox',
  'google_search_emails',
  'google_get_email',
  'google_check_calendar',
  'microsoft_list_messages',
  'microsoft_get_message',
  'microsoft_search_onedrive',
  'microsoft_get_onedrive_file_content',
])

/** One turn's approval gate, shared by Pi and the legacy engine. Requests queue per chat. */
export const createToolAuthorizer = (
  execution: AgentExecution,
  context: Pick<AgentAdapterContext, 'threadId' | 'requestPermission'>,
): AuthorizeTool => {
  let pending: Promise<void> = Promise.resolve()
  return async ({ name, source }, input, id, signal) => {
    signal?.throwIfAborted()
    if (execution.access === 'full' || (source === 'built-in' && readOnlyTools.has(name))) {
      return
    }
    const previous = pending
    const task = (async () => {
      await previous
      signal?.throwIfAborted()
      if (!context.requestPermission) {
        throw new Error('Tool approval is unavailable for this chat')
      }
      const response = await context.requestPermission(
        {
          sessionId: context.threadId,
          toolCall: {
            toolCallId: id,
            title: name,
            kind: source === 'built-in' ? toAcpToolKind(name) : 'other',
            rawInput: { location: execution.location, workingDirectory: execution.cwd, arguments: input },
          },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: i18n._(msg`Allow once`) },
            { optionId: 'deny', kind: 'reject_once', name: i18n._(msg`Deny`) },
          ],
        },
        signal,
      )
      signal?.throwIfAborted()
      if (response.outcome.outcome !== 'selected' || response.outcome.optionId !== 'allow') {
        throw new Error('The user denied this tool action. Do not retry it through another tool.')
      }
    })()
    pending = task.catch(() => {})
    await task
  }
}

/** Gate legacy tools at execution, after validation and before any side effects. */
export const withToolApproval = (
  tools: Record<string, Tool>,
  authorize: AuthorizeTool,
  externalTools: Readonly<Record<string, unknown>> | undefined,
): Record<string, Tool> =>
  Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        ...tool,
        execute: tool.execute
          ? async (input: unknown, options: Parameters<NonNullable<Tool['execute']>>[1]) => {
              await authorize(
                { name, source: externalTools?.[name] ? 'external' : 'built-in' },
                input,
                options.toolCallId,
                options.abortSignal,
              )
              return tool.execute!(input, options)
            }
          : undefined,
      },
    ]),
  )
