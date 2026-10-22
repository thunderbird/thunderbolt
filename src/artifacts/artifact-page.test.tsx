/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { ContentViewProvider } from '@/content-view/context'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { createAuthenticatedClient } from '@/lib/http'
import { resetMiniAppsForTesting } from '@/mini-apps/use-mini-apps'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { artifactId, artifactPath } from './artifact'
import ArtifactPage from './artifact-page'

const id = artifactId({ kind: 'html', messageId: 'message', toolCallId: 'call' })

const renderPage = (path: string, response: () => Response = () => Response.json({ apps: [] })) => {
  const httpClient = createAuthenticatedClient('https://backend.example', () => 'token', {
    fetch: Object.assign(async () => response(), { preconnect: () => {} }),
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={httpClient}>
      <ContentViewProvider>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </ContentViewProvider>
    </HttpClientProvider>
  )
  return renderWithReactivity(
    <Routes>
      <Route path="/artifacts/:artifactId" element={<ArtifactPage />} />
    </Routes>,
    { wrapper, tables: ['settings', 'chat_messages', 'chat_threads'] },
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
  await getDb().insert(chatThreadsTable).values({ id: 'chat' })
  await getDb()
    .insert(chatMessagesTable)
    .values({
      id: 'message',
      role: 'assistant',
      chatThreadId: 'chat',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'render_html',
          toolCallId: 'call',
          state: 'output-available',
          input: { title: 'Saved chart', html: '<p>Saved</p>' },
          output: { ok: true },
        },
      ],
    })
})
afterEach(() => {
  cleanup()
  resetMiniAppsForTesting()
})

describe('artifact routes', () => {
  it('resolves identities containing encoded delimiters through the router', async () => {
    const reference = { kind: 'html' as const, messageId: 'message/second', toolCallId: 'call/with:%2F' }
    await getDb()
      .insert(chatMessagesTable)
      .values({
        id: reference.messageId,
        role: 'assistant',
        chatThreadId: 'chat',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'render_html',
            toolCallId: reference.toolCallId,
            state: 'output-available',
            input: { title: 'Encoded chart', html: '<p>Saved</p>' },
            output: { ok: true },
          },
        ],
      })
    const view = renderPage(artifactPath(artifactId(reference)))
    await settle()
    expect(view.getByTitle('Encoded chart')).toBeTruthy()
  })

  it('reopens a verified unpinned artifact directly after a fresh mount', async () => {
    const first = renderPage(artifactPath(id))
    await settle()
    expect(first.container.querySelectorAll('iframe')).toHaveLength(1)
    first.unmount()
    const reload = renderPage(artifactPath(id))
    await settle()
    expect(reload.getByTitle('Saved chart')).toHaveAttribute('sandbox', 'allow-scripts')
    expect(reload.container.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('loads saved HTML even when configured apps are unreachable', async () => {
    const view = renderPage(artifactPath(id), () => new Response('offline', { status: 503 }))
    await settle()
    expect(view.getByTitle('Saved chart')).toBeTruthy()
    expect(view.queryByText("Couldn't load this artifact. Check your connection and reload.")).toBeNull()
  })

  it('offers the existing conversation when an artifact is unavailable', async () => {
    const view = renderPage(`${artifactPath(artifactId({ kind: 'remote', appId: 'removed' }))}?chat=source%2Fchat`)
    await settle()
    expect(view.getByText('This artifact is no longer available.')).toBeTruthy()
    expect(view.getByRole('link', { name: 'Open conversation' })).toHaveAttribute(
      'href',
      '/chats/source%2Fchat?view=chat',
    )
    expect(view.getByRole('link', { name: 'Back to chat' })).toHaveAttribute('href', '/chats/new')
    expect(view.container.querySelector('iframe')).toBeNull()
  })

  it('distinguishes a failed registry lookup from an artifact that was removed', async () => {
    const view = renderPage(
      artifactPath(artifactId({ kind: 'remote', appId: 'finance' })),
      () => new Response('offline', { status: 503 }),
    )
    await settle()
    expect(view.getByText("Couldn't load this artifact. Check your connection and reload.")).toBeTruthy()
    expect(view.queryByText('This artifact is no longer available.')).toBeNull()
  })

  it('never mounts an invalid or unverified artifact route', async () => {
    const view = renderPage(artifactPath('not-an-artifact'))
    await settle()
    expect(view.getByText('This artifact is no longer available.')).toBeTruthy()
    expect(view.container.querySelector('iframe')).toBeNull()
  })
})
