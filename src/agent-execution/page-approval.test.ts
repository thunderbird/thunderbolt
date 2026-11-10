/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { prepareAiRequestConfig } from '@/ai/fetch'
import { createModel } from '@/dal/models'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createClient } from '@/lib/http'
import { useChatStore } from '@/chats/chat-store'
import { usePageStore } from '@/pages/page-store'
import { pageController } from '@/pages/page-controller'
import { browserController } from '@/browser/browser-controller'
import { createToolAuthorizer, withToolApproval } from './approval'

const observation = {
  documentId: 'doc',
  url: 'about:srcdoc',
  title: 'Page',
  text: '',
  elements: [],
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
}
let sessionId: string
let clean: (() => void)[] = []
const actPage = mock(async () => undefined)
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
  usePageStore.setState({ sessions: [], activeId: null })
  browserController.resume()
  actPage.mockClear()
  sessionId = pageController.open({ id: 'approval-page', title: 'Page', source: { kind: 'html', html: '<p>Page</p>' } })
  clean = [
    pageController.register(sessionId, {
      capabilities: {
        observe: true,
        navigate: false,
        selectElement: true,
        declaredTools: false,
        screenshot: false,
        pointerInput: 'synthetic',
        keyboardInput: 'synthetic',
      },
      snapshot: async () => observation,
      act: actPage,
    }),
    browserController.registerPanel({
      listTabs: () =>
        usePageStore
          .getState()
          .sessions.map((session) => ({ id: session.id, title: 'Page', url: '', active: true, isLoading: false })),
      openTab: () => undefined,
      selectTab: () => {},
      closeTab: () => {},
    }),
  ]
})

afterEach(async () => {
  clean.forEach((dispose) => dispose())
  usePageStore.setState({ sessions: [], activeId: null })
  browserController.resume()
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
  ).page_action!
}

describe('Page actions with agent approvals', () => {
  it.each([
    ['ask', 'allow', 1, 1],
    ['ask', 'deny', 1, 0],
    ['full', 'allow', 0, 1],
  ] as const)('%s / %s prompts %d times and invokes %d times', async (access, decision, prompts, invocations) => {
    const requestPermission = mock(
      async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: 'selected', optionId: decision } }),
    )
    const tool = await prepare(access, requestPermission)
    const result = tool.execute!({ sessionId, type: 'click', x: 20, y: 30 }, { toolCallId: 'change', messages: [] })
    if (decision === 'deny') {
      await expect(result).rejects.toThrow('denied')
    } else {
      expect(await result).toMatchObject({ sessionId, documentId: 'doc' })
    }
    expect(requestPermission).toHaveBeenCalledTimes(prompts)
    expect(actPage).toHaveBeenCalledTimes(invocations)
  })

  it.each(['stop', 'close'] as const)('does not dispatch an approved action after page %s', async (change) => {
    const requested = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<RequestPermissionResponse>()
    const tool = await prepare('ask', async () => {
      requested.resolve()
      return decision.promise
    })
    const result = tool.execute!(
      { sessionId, type: 'click', x: 20, y: 30 },
      { toolCallId: 'stale-change', messages: [] },
    )
    await requested.promise
    if (change === 'stop') {
      browserController.stop()
    } else {
      pageController.close(sessionId)
    }
    decision.resolve(allow)
    await expect(result).rejects.toThrow()
    expect(actPage).not.toHaveBeenCalled()
  })
})
