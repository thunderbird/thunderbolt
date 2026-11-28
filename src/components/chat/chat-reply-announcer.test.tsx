/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aiReact from '@ai-sdk/react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ChatStatus } from 'ai'
import { useChatStore } from '@/chats/chat-store'
import { finishedAnnouncementMs } from '@/chats/reply-announcement'
import { builtInAgent } from '@/defaults/agents'
import { createMockChatInstance, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import type { ThunderboltUIMessage } from '@/types'
import { getClock } from '@/testing-library'
import { setVoiceModeActive } from '@/voice/voice-mode'
import { ChatReplyAnnouncer } from './chat-reply-announcer'

type ChatState = { status: ChatStatus; messages: ThunderboltUIMessage[]; error: Error | undefined }

const userMessage: ThunderboltUIMessage = {
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: 'Capital of France?' }],
}
const reply = (text: string): ThunderboltUIMessage => ({ id: 'a1', role: 'assistant', parts: [{ type: 'text', text }] })

/** Render the announcer over a chat whose `useChat` state each test drives by hand. */
const renderAnnouncer = (initial: Partial<ChatState> = {}) => {
  const state: ChatState = { status: 'ready', messages: [], error: undefined, ...initial }
  spyOn(aiReact, 'useChat').mockImplementation((() => ({ ...state })) as unknown as typeof aiReact.useChat)
  hydrateStore({
    chatInstance: createMockChatInstance(),
    chatThread: null,
    id: 'chat',
    selectedModel: null,
    triggerData: null,
  })
  const view = render(<ChatReplyAnnouncer />)
  const update = (next: Partial<ChatState>) => {
    Object.assign(state, next)
    view.rerender(<ChatReplyAnnouncer />)
  }
  return { update }
}

const politeRegion = () => screen.getByRole('status')
const assertiveRegion = () => screen.getByRole('alert')

describe('ChatReplyAnnouncer', () => {
  beforeEach(resetStore)
  afterEach(() => {
    cleanup()
    mock.restore()
    resetStore()
    setVoiceModeActive(false)
  })

  it('mounts both live regions empty, so their first update is read', () => {
    renderAnnouncer()
    expect(politeRegion()).toHaveTextContent('')
    expect(assertiveRegion()).toHaveTextContent('')
  })

  it('says nothing when it mounts on a reply already streaming', () => {
    renderAnnouncer({ status: 'streaming', messages: [userMessage, reply('Par')] })
    expect(politeRegion()).toHaveTextContent('')
  })

  it('announces the reply is coming, never the streamed tokens, then reads a short reply once', () => {
    const { update } = renderAnnouncer()
    update({ status: 'submitted', messages: [userMessage] })
    expect(politeRegion()).toHaveTextContent(`${builtInAgent.name} is responding`)

    update({ status: 'streaming', messages: [userMessage, reply('**Paris** is')] })
    expect(politeRegion()).toHaveTextContent(`${builtInAgent.name} is responding`)

    update({ status: 'ready', messages: [userMessage, reply('**Paris** is the capital.')] })
    expect(politeRegion()).toHaveTextContent(/^Paris is the capital\.$/)
    expect(assertiveRegion()).toHaveTextContent('')
  })

  it('says "Response ready" for a long reply', () => {
    const { update } = renderAnnouncer()
    update({ status: 'streaming', messages: [userMessage, reply('Long')] })
    update({ status: 'ready', messages: [userMessage, reply('A long answer. '.repeat(40))] })
    expect(politeRegion()).toHaveTextContent(/^Response ready$/)
  })

  it('says "Response stopped" after Stop', () => {
    const { update } = renderAnnouncer()
    update({ status: 'streaming', messages: [userMessage, reply('Partial')] })
    act(() => useChatStore.getState().updateSession('chat', { stopping: true }))
    update({ status: 'ready' })
    expect(politeRegion()).toHaveTextContent(/^Response stopped$/)
  })

  it('announces a failed reply assertively once retries are exhausted', () => {
    const { update } = renderAnnouncer()
    update({ status: 'streaming', messages: [userMessage] })
    update({ status: 'error', error: new Error('boom') })
    expect(assertiveRegion()).toHaveTextContent('')

    act(() => useChatStore.getState().updateSession('chat', { retriesExhausted: true }))
    expect(assertiveRegion()).toHaveTextContent(/^Response failed$/)
    expect(politeRegion()).toHaveTextContent('')
  })

  it('stays quiet in voice mode', () => {
    setVoiceModeActive(true)
    const { update } = renderAnnouncer()
    update({ status: 'submitted', messages: [userMessage] })
    update({ status: 'ready', messages: [userMessage, reply('Hi there.')] })
    expect(politeRegion()).toHaveTextContent('')
  })

  it('empties the polite region a few seconds after reading the reply, so it is not met twice', async () => {
    const { update } = renderAnnouncer()
    update({ status: 'streaming', messages: [userMessage, reply('Hi')] })
    update({ status: 'ready', messages: [userMessage, reply('Hi there.')] })
    expect(politeRegion()).toHaveTextContent(/^Hi there\.$/)

    await act(() => getClock().tickAsync(finishedAnnouncementMs - 1))
    expect(politeRegion()).toHaveTextContent(/^Hi there\.$/)
    await act(() => getClock().tickAsync(1))
    expect(politeRegion()).toHaveTextContent('')
  })

  it('keeps "responding" up for the whole turn', async () => {
    const { update } = renderAnnouncer()
    update({ status: 'submitted', messages: [userMessage] })
    await act(() => getClock().tickAsync(finishedAnnouncementMs * 2))
    expect(politeRegion()).toHaveTextContent(`${builtInAgent.name} is responding`)
  })
})
