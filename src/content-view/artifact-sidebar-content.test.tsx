/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { artifactId, toRemoteArtifact, type Artifact } from '@/artifacts/artifact'
import { useChatStore } from '@/chats/chat-store'
import { usePendingPromptStore } from '@/chats/pending-prompt-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { resolveMiniAppIcon } from '@/mini-apps/registry'
import { resetMiniAppsForTesting } from '@/mini-apps/use-mini-apps'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, fireEvent, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { ArtifactSidebarContent } from './artifact-sidebar-content'
import { ContentViewProvider } from './context'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  resetMiniAppsForTesting()
  useChatStore.setState({ currentSessionId: null })
  usePendingQuotesStore.setState({ quotesByThread: {} })
  usePendingPromptStore.setState({ promptsByThread: {} })
})
afterEach(() => {
  resetMiniAppsForTesting()
  useChatStore.setState({ currentSessionId: null })
  usePendingQuotesStore.setState({ quotesByThread: {} })
  usePendingPromptStore.setState({ promptsByThread: {} })
})

const artifact: Artifact = {
  id: artifactId({ kind: 'html', messageId: 'message', toolCallId: 'call' }),
  reference: { kind: 'html', messageId: 'message', toolCallId: 'call' },
  title: 'Report',
  chatThreadId: 'source-chat',
  source: { kind: 'html', html: '<p>Selected value</p>' },
}

const remoteApp = {
  id: 'finance',
  name: 'Finance',
  description: '',
  icon: '',
  url: 'https://finance.example',
  origin: 'https://finance.example',
}
const remoteArtifact = toRemoteArtifact({ ...remoteApp, icon: resolveMiniAppIcon(remoteApp.icon) })
const settle = async () =>
  act(async () => {
    await getClock().tickAsync(200)
  })

const Location = () => {
  const location = useLocation()
  return (
    <>
      <output>{JSON.stringify(location)}</output>
      <span data-testid="location">{location.pathname + location.search}</span>
    </>
  )
}

const renderPanel = (data: Artifact, route: string) => {
  const Provider = createTestProvider({ mockResponse: { apps: [remoteApp] } })
  const close = mock(() => {})
  const panel = <ArtifactSidebarContent data={data} onClose={close} />
  const view = render(
    <Provider>
      <MemoryRouter initialEntries={[route]}>
        <ContentViewProvider>
          <Routes>
            <Route path="/chats/:chatThreadId" element={panel} />
            <Route path="*" element={panel} />
          </Routes>
          <Location />
        </ContentViewProvider>
      </MemoryRouter>
    </Provider>,
  )
  return { ...view, close }
}

/** Report a real harness selection to exercise the shared host gesture path. */
const selectText = (container: HTMLElement) => {
  const iframe = container.querySelector('iframe')
  const nonce = iframe?.srcdoc.match(/var NONCE = "([^"]+)"/)?.[1]
  expect(nonce).toBeDefined()
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe?.contentWindow,
        data: {
          artifactNonce: nonce,
          type: 'artifact-selection',
          selection: { text: 'Selected value', rect: { x: 10, y: 20, width: 100, height: 20 } },
        },
      }),
    )
  })
}

describe('ArtifactSidebarContent', () => {
  it.each(['/chats/source-chat?view=chat&keep=yes', '/chats/new'])(
    'reveals an already visible source transcript at %s without navigating',
    (route) => {
      useChatStore.setState({ currentSessionId: 'source-chat' })
      const view = renderPanel(artifact, route)
      fireEvent.click(view.getByRole('button', { name: 'Show inline' }))
      expect(view.getByTestId('location').textContent).toBe(route)
      expect(view.close).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['/chats/unrelated-chat', '/artifacts/example?chat=source-chat', '/settings'])(
    'shows generated content in its source transcript when switching inline from %s',
    (route) => {
      const view = renderPanel(artifact, route)
      fireEvent.click(view.getByRole('button', { name: 'Show inline' }))
      expect(view.getByTestId('location').textContent).toBe('/chats/source-chat?view=chat')
      expect(view.close).toHaveBeenCalledTimes(1)
    },
  )

  it('does not offer an inline destination for a configured app without a source transcript', async () => {
    const view = renderPanel(remoteArtifact, '/chats/current-chat')
    await settle()
    expect(view.queryByRole('button', { name: 'Show inline' })).toBeNull()
    expect(view.getByRole('button', { name: 'Open full screen' })).toBeTruthy()
  })

  it('attaches selections to the artifact’s origin even when another chat route is open', () => {
    const view = renderPanel(artifact, '/chats/unrelated-chat')
    selectText(view.container)
    fireEvent.click(view.getByRole('button', { name: 'Ask about this' }))
    expect(usePendingQuotesStore.getState().quotesByThread['source-chat'].map((quote) => quote.data.text)).toEqual([
      'Selected value',
    ])
    expect(usePendingQuotesStore.getState().quotesByThread['unrelated-chat']).toBeUndefined()
    expect(view.getByTestId('location').textContent).toBe('/chats/source-chat?view=chat')
    expect(view.close).not.toHaveBeenCalled()
  })

  it.each(['/artifacts', '/artifacts/example?chat=unrelated-chat'])(
    'navigates from %s to the source conversation before closing the selection panel',
    (route) => {
      const view = renderPanel(artifact, route)
      selectText(view.container)
      fireEvent.click(view.getByRole('button', { name: 'Ask about this' }))
      expect(usePendingQuotesStore.getState().quotesByThread['source-chat'].map((quote) => quote.data.text)).toEqual([
        'Selected value',
      ])
      expect(usePendingQuotesStore.getState().quotesByThread['unrelated-chat']).toBeUndefined()
      expect(view.getByTestId('location').textContent).toBe('/chats/source-chat?view=chat')
      expect(view.close).toHaveBeenCalledTimes(1)
    },
  )

  it('uses the current chat when the artifact has no originating conversation', () => {
    const view = renderPanel({ ...artifact, chatThreadId: null }, '/chats/current-chat')
    selectText(view.container)
    fireEvent.click(view.getByRole('button', { name: 'Ask about this' }))
    expect(usePendingQuotesStore.getState().quotesByThread['current-chat']).toHaveLength(1)
    expect(view.close).not.toHaveBeenCalled()
  })

  it('attaches a selection to the live draft session on /chats/new rather than the route placeholder', () => {
    const view = renderPanel({ ...artifact, chatThreadId: null }, '/chats/new')
    act(() => useChatStore.setState({ currentSessionId: 'live-draft' }))
    selectText(view.container)
    fireEvent.click(view.getByRole('button', { name: 'Ask about this' }))
    expect(usePendingQuotesStore.getState().quotesByThread['live-draft'].map((quote) => quote.data.text)).toEqual([
      'Selected value',
    ])
    expect(usePendingQuotesStore.getState().quotesByThread['new']).toBeUndefined()
    expect(view.getByTestId('location').textContent).toBe('/chats/new')
    expect(view.close).not.toHaveBeenCalled()
  })

  it('keeps the live draft when the chat button is clicked without treating the click as a prompt', () => {
    useChatStore.setState({ currentSessionId: 'live-draft' })
    const view = renderPanel({ ...artifact, chatThreadId: null }, '/chats/new')
    fireEvent.click(view.getByRole('button', { name: 'Chat about artifact' }))
    expect(view.getByTestId('location').textContent).toBe('/chats/new')
    expect(view.close).not.toHaveBeenCalled()
    expect(usePendingPromptStore.getState().promptsByThread).toEqual({})
  })

  it.each(['/artifacts/example', '/chats/new'])(
    'opens a real draft conversation from %s with the passage queued when no conversation exists',
    (route) => {
      const view = renderPanel({ ...artifact, chatThreadId: null }, route)
      selectText(view.container)
      fireEvent.click(view.getByRole('button', { name: 'Ask about this' }))
      const location = JSON.parse(view.container.querySelector('output')?.textContent ?? '{}')
      const draftId = location.state.artifactDraftChatId
      expect(typeof draftId).toBe('string')
      expect(draftId).not.toBe('new')
      expect(usePendingQuotesStore.getState().quotesByThread['new']).toBeUndefined()
      expect(usePendingQuotesStore.getState().quotesByThread[draftId].map((quote) => quote.data.text)).toEqual([
        'Selected value',
      ])
      expect(view.close).toHaveBeenCalledTimes(1)
    },
  )
})
