/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import { ContentViewProvider } from '@/content-view/context'
import { createProject } from '@/dal/projects'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createTestProvider } from '@/test-utils/test-provider'
import { useProjectArtifactWorkspaceState } from './use-project-artifact-workspace-state'
import type { ProjectArtifact } from './project-artifacts-data'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(() => usePendingQuotesStore.setState({ quotesByThread: {} }))

const artifact: ProjectArtifact = {
  id: 'message-call',
  messageId: 'message',
  toolCallId: 'call',
  chatThreadId: 'source-chat',
  chatTitle: 'Source chat',
  title: 'Chart',
  html: '<h1>Chart</h1>',
  createdAt: new Date(),
}

/** Exercise URL and quote handoff with the real router and providers. */
const renderWorkspace = async () => {
  const project = await createProject(getDb(), { name: 'Research' })
  const TestProvider = createTestProvider()
  return renderHook(
    () => ({
      workspace: useProjectArtifactWorkspaceState(project, artifact, [artifact]),
      location: useLocation(),
      navigate: useNavigate(),
    }),
    {
      wrapper: ({ children }) => (
        <TestProvider>
          <MemoryRouter initialEntries={['/projects/project/artifacts/message-call?filter=recent&chat=other-chat']}>
            <ContentViewProvider>{children}</ContentViewProvider>
          </MemoryRouter>
        </TestProvider>
      ),
    },
  )
}

it('opens only the source conversation, preserves other query parameters, and follows navigation', async () => {
  const { result } = await renderWorkspace()
  expect(result.current.workspace.showChat).toBe(false)
  act(() => result.current.workspace.openSourceChat())
  expect(result.current.workspace.showChat).toBe(true)
  expect(result.current.location.search).toBe('?filter=recent&chat=source-chat')
  act(() => result.current.workspace.closeSourceChat())
  expect(result.current.workspace.showChat).toBe(false)
  expect(result.current.location.search).toBe('?filter=recent')
  act(() => result.current.navigate('?filter=recent&chat=source-chat'))
  expect(result.current.workspace.showChat).toBe(true)
  act(() => result.current.navigate(-1))
  expect(result.current.workspace.showChat).toBe(false)
})

it('hands selected passages to the source chat and reveals the canvas without discarding those quotes', async () => {
  const { result } = await renderWorkspace()
  act(() => {
    result.current.workspace.contentView.showArtifact({
      html: '<p>Overlay</p>',
      title: 'Overlay',
      artifactId: 'other',
      chatThreadId: 'source-chat',
    })
  })
  act(() => result.current.workspace.askAbout(['First passage', 'Second passage']))
  expect(result.current.workspace.showChat).toBe(true)
  expect(result.current.workspace.contentView.isOpen).toBe(false)
  expect(usePendingQuotesStore.getState().quotesByThread['source-chat'].map((quote) => quote.data.text)).toEqual([
    'First passage',
    'Second passage',
  ])
  expect(usePendingQuotesStore.getState().quotesByThread['other-chat']).toBeUndefined()
  act(() => result.current.workspace.reveal())
  expect(result.current.workspace.showPanel).toBe(false)
  expect(result.current.location.search).toBe('?filter=recent')
  expect(usePendingQuotesStore.getState().quotesByThread['source-chat']).toHaveLength(2)
})
