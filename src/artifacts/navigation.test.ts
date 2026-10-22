/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { NavigateFunction } from 'react-router'
import { usePendingPromptStore } from '@/chats/pending-prompt-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { resolveMiniAppIcon } from '@/mini-apps/registry'
import { artifactId, artifactPath, toRemoteArtifact, type Artifact } from './artifact'
import { artifactChatOrigin, artifactDraftChatId, openArtifactChat } from './navigation'

const html: Artifact = {
  id: artifactId({ kind: 'html', messageId: 'message', toolCallId: 'call' }),
  reference: { kind: 'html', messageId: 'message', toolCallId: 'call' },
  title: 'Chart',
  chatThreadId: 'source/chat',
  source: { kind: 'html', html: '<p>Chart</p>' },
}
const remote = toRemoteArtifact({
  id: 'finance',
  name: 'Finance',
  description: '',
  icon: resolveMiniAppIcon(''),
  url: 'https://finance.example/app',
  origin: 'https://finance.example',
})

afterEach(() => {
  usePendingPromptStore.setState({ promptsByThread: {} })
  usePendingQuotesStore.setState({ quotesByThread: {} })
})

describe('artifact chat navigation', () => {
  it('opens the source conversation and queues passages/prompt before navigation', () => {
    const navigate = mock(() => {
      expect(usePendingQuotesStore.getState().quotesByThread['source/chat']?.map(({ data }) => data.text)).toEqual([
        'Revenue',
        'Forecast',
      ])
      expect(usePendingPromptStore.getState().promptsByThread['source/chat']).toBe('Explain this')
    }) as ReturnType<typeof mock> & NavigateFunction
    openArtifactChat(html, navigate, { passages: ['Revenue', 'Forecast'], prompt: 'Explain this' })
    expect(navigate).toHaveBeenCalledWith(`${artifactPath(html.id)}?chat=source%2Fchat`)
  })

  it('starts a remote app draft through navigation state without promising a persisted URL chat', () => {
    const navigate = mock(() => {}) as ReturnType<typeof mock> & NavigateFunction
    openArtifactChat(remote, navigate, { passages: ['A selected row'], prompt: 'Describe it' })
    const [path, options] = navigate.mock.calls[0] as unknown as [string, { state: unknown }]
    const id = artifactDraftChatId(options.state)
    expect(path).toBe(artifactPath(remote.id))
    expect(path).not.toContain('?chat=')
    expect(id).not.toBeNull()
    expect(usePendingQuotesStore.getState().quotesByThread[id!]?.[0]?.data.text).toBe('A selected row')
    expect(usePendingPromptStore.getState().promptsByThread[id!]).toBe('Describe it')
  })

  it('does not overwrite an existing queued prompt when no prompt was requested', () => {
    usePendingPromptStore.getState().setPrompt('source/chat', 'Already queued')
    openArtifactChat(html, mock(() => {}) as NavigateFunction)
    expect(usePendingPromptStore.getState().promptsByThread['source/chat']).toBe('Already queued')
  })

  it('preserves configured app provenance while namespacing generated artifacts', () => {
    expect(artifactChatOrigin(remote)).toBe('finance')
    expect(artifactChatOrigin(html)).toBe(html.id)
  })

  it.each([null, undefined, 'draft', {}, { artifactDraftChatId: '' }, { artifactDraftChatId: 123 }])(
    'ignores malformed navigation state %j',
    (state) => {
      expect(artifactDraftChatId(state)).toBeNull()
    },
  )
})
