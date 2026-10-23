/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { AppWindow } from 'lucide-react'
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { prepareAiRequestConfig } from '@/ai/fetch'
import { createModel } from '@/dal/models'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createClient } from '@/lib/http'
import { useChatStore } from '@/chats/chat-store'
import { useMiniAppStore } from '@/mini-apps/mini-app-store'
import { createToolAuthorizer, withToolApproval } from './approval'

const app = {
  id: 'approval-test',
  name: 'Approval test',
  description: 'Test app',
  icon: AppWindow,
  url: 'https://app.test',
  origin: 'https://app.test',
}
const declaredTools = [{ name: 'set_assumption', description: 'Change an assumption.' }]
const allow: RequestPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow' } }

beforeEach(async () => {
  useChatStore.setState({ sessions: new Map() })
  await setupTestDatabase()
  await createModel(getDb(), {
    id: 'approval-model',
    name: 'Test',
    provider: 'openai',
    model: 'gpt-test',
    toolUsage: 1,
  })
  useMiniAppStore.getState().openApp(app)
})

afterEach(async () => {
  useMiniAppStore.getState().closeApp()
  await teardownTestDatabase()
})

/** Exercise production tool registration and the legacy execution approval boundary together. */
const prepare = async (access: 'ask' | 'full', requestPermission: () => Promise<RequestPermissionResponse>) => {
  const config = await prepareAiRequestConfig({
    modelId: 'approval-model',
    chatThreadId: 'approval-chat',
    toolApprovalHandled: true,
    httpClient: createClient({
      prefixUrl: 'https://backend.test',
      fetch: async () => {
        throw new Error('Unexpected network request')
      },
    }),
  })
  return withToolApproval(
    config.toolset,
    createToolAuthorizer({ location: 'sandbox', access }, { threadId: 'approval-chat', requestPermission }),
    config.mcpToolsMetadata,
  ).app_set_assumption!
}

describe('Mini App actions with agent approvals', () => {
  it.each([
    ['ask', 'allow', 1, 1],
    ['ask', 'deny', 1, 0],
    ['full', 'allow', 0, 1],
  ] as const)('%s / %s prompts %d times and invokes %d times', async (access, decision, prompts, invocations) => {
    const invoke = mock(async () => ({ content: 'changed' }))
    useMiniAppStore.getState().setTools(declaredTools, invoke)
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'selected', optionId: decision } }),
    )
    const tool = await prepare(access, requestPermission)
    const result = tool.execute!({}, { toolCallId: 'change', messages: [] })
    if (decision === 'deny') {
      await expect(result).rejects.toThrow('denied')
    } else {
      expect(await result).toBe('changed')
    }
    expect(requestPermission).toHaveBeenCalledTimes(prompts)
    expect(invoke).toHaveBeenCalledTimes(invocations)
  })

  it.each(['reload', 'close'] as const)('does not dispatch an approved action after app %s', async (change) => {
    const invoke = mock(async () => ({ content: 'changed' }))
    useMiniAppStore.getState().setTools(declaredTools, invoke)
    const requested = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<RequestPermissionResponse>()
    const tool = await prepare('ask', async () => {
      requested.resolve()
      return decision.promise
    })
    const result = tool.execute!({}, { toolCallId: 'stale-change', messages: [] })
    await requested.promise
    if (change === 'reload') {
      useMiniAppStore.getState().resetGuest()
      // The bridge reuses the same callTool callback after a fresh handshake.
      useMiniAppStore.getState().setTools(declaredTools, invoke)
    } else {
      useMiniAppStore.getState().closeApp()
    }
    decision.resolve(allow)
    expect(await result).toContain('app changed or closed')
    expect(invoke).not.toHaveBeenCalled()
  })
})
