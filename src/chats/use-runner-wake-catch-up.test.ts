/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wake catch-up: the two moments a client can start talking to the runner again
 * without a page load — the tab regaining focus and the network coming back.
 *
 * Subscription and decision are tested separately: `subscribeToWakeSignals` gets
 * fake event targets, and `catchUpOnWake` runs against a hydrated store. Driving
 * the hook itself would need a router and PowerSync to assert one `resumeStream`.
 */

import '@/testing-library'

import { builtInAgent } from '@/defaults/agents'
import { setupConsoleSpy, type ConsoleSpies } from '@/test-utils/console-spies'
import {
  createMockChatInstance,
  createMockChatThread,
  createMockModel,
  hydrateStore,
} from '@/test-utils/chat-store-mocks'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent } from '@/types/acp'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { useChatStore } from './chat-store'
import { catchUpOnWake, subscribeToWakeSignals } from './use-runner-wake-catch-up'

type Listener = () => void

/** Minimal `EventTarget` that records listeners so a test can fire by name. */
const createFakeTarget = () => {
  const listeners = new Map<string, Set<Listener>>()
  return {
    target: {
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        const set = listeners.get(type) ?? new Set<Listener>()
        set.add(listener as Listener)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(listener as Listener)
      },
    },
    emit: (type: string) => {
      for (const listener of listeners.get(type) ?? []) {
        listener()
      }
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

describe('subscribeToWakeSignals', () => {
  it('wakes when the tab becomes visible', () => {
    const visibility = createFakeTarget()
    const onWake = mock(() => {})

    subscribeToWakeSignals(onWake, {
      visibilityTarget: visibility.target,
      onlineTarget: createFakeTarget().target,
      isVisible: () => true,
    })
    visibility.emit('visibilitychange')

    expect(onWake).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the same event means the tab was hidden', () => {
    const visibility = createFakeTarget()
    const onWake = mock(() => {})

    subscribeToWakeSignals(onWake, {
      visibilityTarget: visibility.target,
      onlineTarget: createFakeTarget().target,
      isVisible: () => false,
    })
    visibility.emit('visibilitychange')

    expect(onWake).not.toHaveBeenCalled()
  })

  it('wakes when the network comes back', () => {
    const online = createFakeTarget()
    const onWake = mock(() => {})

    subscribeToWakeSignals(onWake, {
      visibilityTarget: createFakeTarget().target,
      onlineTarget: online.target,
      isVisible: () => true,
    })
    online.emit('online')

    expect(onWake).toHaveBeenCalledTimes(1)
  })

  it('removes both listeners on unsubscribe', () => {
    const visibility = createFakeTarget()
    const online = createFakeTarget()

    const unsubscribe = subscribeToWakeSignals(() => {}, {
      visibilityTarget: visibility.target,
      onlineTarget: online.target,
      isVisible: () => true,
    })
    unsubscribe()

    expect(visibility.count('visibilitychange')).toBe(0)
    expect(online.count('online')).toBe(0)
  })
})

const unansweredUser: ThunderboltUIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }
const answered: ThunderboltUIMessage = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'done' }] }

type SeedOptions = {
  messages?: ThunderboltUIMessage[]
  status?: 'ready' | 'streaming' | 'submitted' | 'error'
  acpSessionId?: string | null
  agent?: Agent
}

/** Hydrate one session and hand back its `resumeStream` spy. */
const seedSession = (
  id: string,
  { messages = [unansweredUser], status = 'ready', acpSessionId = 'sess-1', agent = builtInAgent }: SeedOptions = {},
) => {
  const chatInstance = createMockChatInstance(messages, status)
  const resumeStream = mock(async () => {})
  Object.assign(chatInstance, { resumeStream })
  const model = createMockModel()

  hydrateStore({
    chatInstance,
    chatThread: createMockChatThread({ id, acpSessionId }),
    id,
    mcpClients: [],
    models: [model],
    selectedModel: model,
    triggerData: null,
  })
  useChatStore.setState((state) => {
    const sessions = new Map(state.sessions)
    const session = sessions.get(id)
    if (session) {
      sessions.set(id, { ...session, selectedAgent: agent })
    }
    return { sessions }
  })
  return { resumeStream }
}

describe('catchUpOnWake', () => {
  let consoleSpies: ConsoleSpies

  beforeEach(() => {
    useChatStore.setState({ sessions: new Map(), currentSessionId: null })
    consoleSpies = setupConsoleSpy()
  })

  afterEach(() => {
    consoleSpies.restore()
  })

  it('resumes an interrupted runner-owned turn', () => {
    const { resumeStream } = seedSession('t1')

    catchUpOnWake('t1')

    expect(resumeStream).toHaveBeenCalledTimes(1)
  })

  it('never regenerates — the turn already ran and may have executed tools', () => {
    seedSession('t1')

    catchUpOnWake('t1')

    const session = useChatStore.getState().sessions.get('t1')
    expect(session?.chatInstance.regenerate).not.toHaveBeenCalled()
  })

  it('leaves a local built-in thread alone', () => {
    const { resumeStream } = seedSession('t1', { acpSessionId: null })

    catchUpOnWake('t1')

    expect(resumeStream).not.toHaveBeenCalled()
  })

  it('leaves a completed transcript alone', () => {
    const { resumeStream } = seedSession('t1', { messages: [unansweredUser, answered] })

    catchUpOnWake('t1')

    expect(resumeStream).not.toHaveBeenCalled()
  })

  it('does not pile onto a stream that is already running', () => {
    const { resumeStream } = seedSession('t1', { status: 'streaming' })

    catchUpOnWake('t1')

    expect(resumeStream).not.toHaveBeenCalled()
  })

  it('does not double up on a submitted turn either', () => {
    const { resumeStream } = seedSession('t1', { status: 'submitted' })

    catchUpOnWake('t1')

    expect(resumeStream).not.toHaveBeenCalled()
  })

  it('ignores a session that is not hydrated', () => {
    expect(() => catchUpOnWake('missing')).not.toThrow()
  })

  it('logs a failed catch-up instead of surfacing an unhandled rejection', async () => {
    const chatInstance = createMockChatInstance([unansweredUser], 'ready')
    Object.assign(chatInstance, { resumeStream: mock(() => Promise.reject(new Error('offline'))) })
    const model = createMockModel()
    hydrateStore({
      chatInstance,
      chatThread: createMockChatThread({ id: 't1', acpSessionId: 'sess-1' }),
      id: 't1',
      mcpClients: [],
      models: [model],
      selectedModel: model,
      triggerData: null,
    })

    catchUpOnWake('t1')
    await Promise.resolve()

    expect(consoleSpies.error).toHaveBeenCalled()
  })
})
