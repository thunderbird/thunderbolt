import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import type { ThunderboltUIMessage } from '@/types'
import { cleanup, render, act } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { SavePartialAssistantMessagesHandler } from './save-partial-assistant-messages-handler'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { getClock } from '@/testing-library'

describe('SavePartialAssistantMessagesHandler', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(() => {
    resetStore()
  })

  afterEach(async () => {
    cleanup()
    resetStore()
    await resetTestDatabase()
  })

  it('should render children without modification', () => {
    const mockSaveMessages = mock(() => Promise.resolve())
    const model = createMockModel()

    hydrateStore({
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      selectedModel: model,
      triggerData: null,
    })

    const { container } = render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>
        <div data-testid="child">Test Child</div>
      </SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    expect(container.querySelector('[data-testid="child"]')).toBeInTheDocument()
    expect(container.textContent).toBe('Test Child')
  })

  it('should not save messages when not streaming', async () => {
    const clock = getClock()
    const mockSaveMessages = mock(() => Promise.resolve())
    const model = createMockModel()
    const messages: ThunderboltUIMessage[] = [
      { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] },
    ]

    hydrateStore({
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      messages,
      status: 'ready',
      selectedModel: model,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>test</SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Advance past throttle delay
    await act(async () => {
      clock.tick(250)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })

  it('should save messages when streaming with assistant message', async () => {
    const clock = getClock()
    const mockSaveMessages = mock(() => Promise.resolve())
    const model = createMockModel()
    const messages: ThunderboltUIMessage[] = [
      { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'Hi there' }] },
    ]

    hydrateStore({
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      messages,
      status: 'streaming',
      selectedModel: model,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>test</SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    // Advance past throttle delay
    await act(async () => {
      clock.tick(250)
    })

    expect(mockSaveMessages).toHaveBeenCalled()
  })

  it('should not save when streaming but last message is user', async () => {
    const clock = getClock()
    const mockSaveMessages = mock(() => Promise.resolve())
    const model = createMockModel()
    const messages: ThunderboltUIMessage[] = [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }]

    hydrateStore({
      chatThread: null,
      id: 'thread-1',
      mcpClients: [],
      messages,
      status: 'streaming',
      selectedModel: model,
      triggerData: null,
    })

    render(
      <SavePartialAssistantMessagesHandler saveMessages={mockSaveMessages}>test</SavePartialAssistantMessagesHandler>,
      { wrapper: createQueryTestWrapper() },
    )

    await act(async () => {
      clock.tick(250)
    })

    expect(mockSaveMessages).not.toHaveBeenCalled()
  })
})
