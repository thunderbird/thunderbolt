/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import * as chatDetail from '@/chats/detail'
import { useChatStore } from '@/chats/chat-store'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { ContentViewProvider } from '@/content-view/context'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import * as mobileModule from '@/hooks/use-mobile'
import { createAuthenticatedClient } from '@/lib/http'
import { resolveMiniAppIcon } from '@/mini-apps/registry'
import { resetMiniAppsForTesting } from '@/mini-apps/use-mini-apps'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { artifactId, artifactPath, toRemoteArtifact, type Artifact } from './artifact'
import { ArtifactWorkspace } from './artifact-workspace'

const sourceChatId = uuidv7()
const artifact: Artifact = {
  id: artifactId({ kind: 'html', messageId: 'message', toolCallId: 'call' }),
  reference: { kind: 'html', messageId: 'message', toolCallId: 'call' },
  title: 'Working chart',
  chatThreadId: sourceChatId,
  source: { kind: 'html', html: '<p>Working</p>' },
}
const LocationProbe = () => {
  const location = useLocation()
  return <span data-testid="location">{location.pathname + location.search}</span>
}
const renderWorkspace = (options: { query?: string; draftId?: string; source?: Artifact } = {}) => {
  const source = options.source ?? artifact
  const httpClient = createAuthenticatedClient('https://backend.example', () => 'token', {
    fetch: Object.assign(async () => Response.json({ apps: [] }), { preconnect: () => {} }),
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={httpClient}>
      <ContentViewProvider>
        <MemoryRouter
          initialEntries={[
            {
              pathname: artifactPath(source.id),
              search: options.query ?? '',
              state: options.draftId ? { artifactDraftChatId: options.draftId } : null,
            },
          ]}
        >
          {children}
        </MemoryRouter>
      </ContentViewProvider>
    </HttpClientProvider>
  )
  return renderWithReactivity(
    <>
      <LocationProbe />
      <Routes>
        <Route path="/artifacts/:artifactId" element={<ArtifactWorkspace artifact={source} />} />
        <Route path="/chats/:chatThreadId" element={<p>Source conversation</p>} />
      </Routes>
    </>,
    { wrapper, tables: ['settings', 'chat_threads', 'chat_messages'] },
  )
}
const settle = async () =>
  act(async () => {
    await getClock().tickAsync(200)
  })

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  resetMiniAppsForTesting()
  await resetTestDatabase()
  await getDb().insert(chatThreadsTable).values({ id: sourceChatId, title: 'Source conversation' })
  // The workspace owns which persisted/draft session to hydrate; the chat engine itself has separate suites.
  spyOn(chatDetail, 'ChatHydrateHandler').mockImplementation(({ existingId, newChatId, miniAppId, onCreated }) => (
    <div
      data-testid="conversation"
      data-existing-id={existingId ?? ''}
      data-draft-id={existingId ? '' : newChatId}
      data-origin={miniAppId}
    >
      <button onClick={() => onCreated?.(newChatId)}>Persist conversation</button>
    </div>
  ))
})
afterEach(() => {
  cleanup()
  mock.restore()
  resetMiniAppsForTesting()
  useChatStore.setState({ sessions: new Map(), currentSessionId: null })
})

describe('artifact conversation workspace', () => {
  it('opens one executable surface and creates a draft only when chat is requested', async () => {
    const view = renderWorkspace()
    await settle()
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1)
    expect(view.queryByTestId('conversation')).toBeNull()
    const frame = view.getByTitle('Working chart')
    fireEvent.click(view.getByRole('button', { name: 'Chat' }))
    await settle()
    expect(view.getByTestId('conversation').getAttribute('data-draft-id')).not.toBe('')
    expect(view.getByTestId('conversation')).toHaveAttribute('data-existing-id', '')
    expect(view.getByTestId('conversation')).toHaveAttribute('data-origin', artifact.id)
    expect(view.getByTestId('location').textContent).not.toContain('?chat=')
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1)
    expect(view.getByTitle('Working chart')).toBe(frame)
  })

  it('keeps the same draft across sidebar/fullscreen and promotes its first save into the URL', async () => {
    const view = renderWorkspace({ draftId: 'draft-from-library' })
    await settle()
    const frame = view.getByTitle('Working chart')
    expect(view.getByTestId('conversation')).toHaveAttribute('data-draft-id', 'draft-from-library')
    fireEvent.click(view.getByRole('button', { name: 'Open in side panel' }))
    await settle()
    expect(view.getByTestId('conversation')).toHaveAttribute('data-draft-id', 'draft-from-library')
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1)
    expect(view.getByTitle('Working chart')).toBe(frame)
    fireEvent.click(view.getByRole('button', { name: 'Open full screen' }))
    await settle()
    expect(view.getByTestId('conversation')).toHaveAttribute('data-draft-id', 'draft-from-library')
    expect(view.getByTitle('Working chart')).toBe(frame)
    fireEvent.click(view.getByRole('button', { name: 'Persist conversation' }))
    await settle()
    expect(view.getByTestId('conversation')).toHaveAttribute('data-existing-id', 'draft-from-library')
    expect(view.getByTestId('location').textContent).toContain('?chat=draft-from-library')
    expect(view.getByTitle('Working chart')).toBe(frame)
  })

  it('retains a persisted conversation URL while changing display modes', async () => {
    const view = renderWorkspace({ query: '?chat=existing-chat' })
    await settle()
    expect(view.getByTestId('conversation')).toHaveAttribute('data-existing-id', 'existing-chat')
    const frame = view.getByTitle('Working chart')
    fireEvent.click(view.getByRole('button', { name: 'Open in side panel' }))
    await settle()
    expect(view.getByTitle('Working chart')).toBe(frame)
    fireEvent.click(view.getByRole('button', { name: 'Open full screen' }))
    await settle()
    expect(view.getByTestId('location').textContent).toBe(`${artifactPath(artifact.id)}?chat=existing-chat`)
    expect(view.getByTestId('conversation')).toHaveAttribute('data-existing-id', 'existing-chat')
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1)
    expect(view.getByTitle('Working chart')).toBe(frame)
  })

  it('reopens a closed persisted chat when moving the artifact to the sidebar', async () => {
    const view = renderWorkspace({ query: '?chat=existing-chat' })
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Close panel' }))
    await settle()
    expect(view.queryByTestId('conversation')).toBeNull()
    expect(view.getByTestId('location').textContent).not.toContain('?chat=')
    fireEvent.click(view.getByRole('button', { name: 'Open in side panel' }))
    await settle()
    expect(view.getByTestId('conversation')).toHaveAttribute('data-existing-id', 'existing-chat')
    expect(view.getByTestId('location').textContent).toBe(`${artifactPath(artifact.id)}?chat=existing-chat`)
  })

  it('returns generated content inline in its source chat without a provenance redirect', async () => {
    const view = renderWorkspace()
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Show inline' }))
    await settle()
    expect(view.getByText('Source conversation')).toBeTruthy()
    expect(view.getByTestId('location').textContent).toBe(`/chats/${sourceChatId}?view=chat`)
    expect(view.container.querySelector('iframe')).toBeNull()
  })

  it('keeps configured-app provenance without an inline destination outside a source transcript', async () => {
    const source = toRemoteArtifact({
      id: 'finance',
      name: 'Finance',
      description: '',
      icon: resolveMiniAppIcon(''),
      url: 'https://finance.example',
      origin: 'https://finance.example',
    })
    const view = renderWorkspace({ source, draftId: 'remote-draft' })
    await settle()
    expect(view.getByTestId('conversation')).toHaveAttribute('data-origin', 'finance')
    expect(view.queryByRole('button', { name: 'Show inline' })).toBeNull()
    expect(view.getByRole('button', { name: 'Open in side panel' })).toBeTruthy()
    expect(view.getByTestId('location').textContent).toBe(artifactPath(source.id))
  })

  it('keeps the conversation reachable at mobile widths without mounting duplicate frames', async () => {
    spyOn(mobileModule, 'useIsMobile').mockReturnValue({ isMobile: true })
    const view = renderWorkspace({ query: '?chat=existing-chat' })
    await settle()
    expect(view.getByTestId('conversation')).toHaveAttribute('data-existing-id', 'existing-chat')
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1)
    const frame = view.getByTitle('Working chart')
    expect(frame.closest('[inert][aria-hidden="true"]')).not.toBeNull()
    expect(view.getByTestId('conversation').closest('[inert], [aria-hidden="true"]')).toBeNull()
    expect(view.queryByRole('button', { name: 'Open in side panel' })).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'Close panel' }))
    await settle()
    expect(view.queryByTestId('conversation')).toBeNull()
    expect(view.getByTitle('Working chart')).toBe(frame)
    expect(frame.closest('[inert], [aria-hidden="true"]')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'Chat' }))
    await settle()
    expect(view.getByTestId('conversation')).toHaveAttribute('data-existing-id', 'existing-chat')
    expect(view.getByTitle('Working chart')).toBe(frame)
    expect(frame.closest('[inert][aria-hidden="true"]')).not.toBeNull()
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1)
  })
})
