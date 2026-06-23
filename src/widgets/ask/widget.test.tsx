/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// The connected widget reaches the live chat session, the message cache, and a
// React Query store. Stub all three so we can assert *only* the autoturn
// dispatch decision per mode. `useQuery` is stubbed to resolve synchronously so
// the widget renders its options immediately (no provider / async wait needed).
const sendMessage = mock(async (_message: { text: string }) => {})
mock.module('@/chats/chat-store', () => ({ useCurrentChatSession: () => ({ chatInstance: { sendMessage } }) }))
mock.module('@/contexts', () => ({ useDatabase: () => ({}) }))
mock.module('@/dal/chat-messages', () => ({ getMessage: async () => null, updateMessageCache: async () => {} }))
mock.module('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null, isPending: false }),
  useQueryClient: () => ({ setQueryData: () => {} }),
}))

const { AskWidget } = await import('./widget')
import type { AskMode, AskOption } from './lib'

const options: AskOption[] = [
  { id: 'a', text: 'Draft a reply', isCorrect: true },
  { id: 'b', text: 'Archive it' },
]

const renderWidget = (mode: AskMode, opts: AskOption[] = options) =>
  render(<AskWidget prompt="What next?" mode={mode} options={opts} messageId="m1" />)

// Let handleSubmit's async chain (persist → dispatch) settle.
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AskWidget — autoturn dispatch', () => {
  beforeEach(() => sendMessage.mockClear())
  afterEach(cleanup)

  it('choice: dispatches the chosen option text as a turn', async () => {
    renderWidget('choice')
    fireEvent.click(screen.getByText('Draft a reply'))
    await flush()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toEqual({ text: 'Draft a reply' })
  })

  it('free: dispatches the typed answer as a turn', async () => {
    renderWidget('free', [])
    fireEvent.change(screen.getByPlaceholderText('Type your answer…'), {
      target: { value: 'It keeps data private end to end.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await flush()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toEqual({ text: 'It keeps data private end to end.' })
  })

  it('single: reveals locally and does NOT dispatch a turn (no quiz loop)', async () => {
    renderWidget('single')
    fireEvent.click(screen.getByText('Draft a reply'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await flush()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('multiple: does NOT dispatch a turn', async () => {
    renderWidget('multiple')
    fireEvent.click(screen.getByText('Draft a reply'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await flush()
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
