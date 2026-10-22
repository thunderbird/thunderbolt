/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { artifactId, artifactPath, type Artifact } from '@/artifacts/artifact'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import { getDb } from '@/db/database'
import { getArtifactPinsQuery, setArtifactPinned } from '@/dal/artifacts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { act, fireEvent, render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { AppWindow } from 'lucide-react'
import { MemoryRouter, useLocation } from 'react-router'
import { ArtifactControls } from './artifact-controls'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

const htmlArtifact = (callId: string): Artifact => ({
  id: artifactId({ kind: 'html', messageId: 'message', toolCallId: callId }),
  reference: { kind: 'html', messageId: 'message', toolCallId: callId },
  title: 'Chart',
  chatThreadId: 'source-chat',
  source: { kind: 'html', html: '<h1>Chart</h1>' },
})

const ViewState = () => {
  const { state } = useContentView()
  const location = useLocation()
  return (
    <output>
      {JSON.stringify({ path: location.pathname, panelId: state.type === 'artifact' ? state.data.id : null })}
    </output>
  )
}

const renderControls = (
  artifact: Artifact,
  display: 'inline' | 'sidebar' | 'fullscreen' = 'inline',
  onOpenInPanel?: () => void,
  onOpenFullScreen?: () => void,
) => {
  const Provider = createTestProvider()
  return render(
    <Provider>
      <MemoryRouter initialEntries={['/chats/source-chat']}>
        <ContentViewProvider>
          <ArtifactControls
            artifact={artifact}
            display={display}
            onOpenInPanel={onOpenInPanel}
            onOpenFullScreen={onOpenFullScreen}
          />
          <ViewState />
        </ContentViewProvider>
      </MemoryRouter>
    </Provider>,
  )
}

const settle = async () => {
  await act(async () => {
    await getClock().tickAsync(10)
  })
}

describe('ArtifactControls', () => {
  it('opens the same source in the side panel, then closes that panel before full-screen navigation', async () => {
    const artifact = htmlArtifact('navigation')
    const view = renderControls(artifact)
    fireEvent.click(view.getByRole('button', { name: 'Open in side panel' }))
    expect(view.container.querySelector('output')?.textContent).toContain(artifact.id)
    fireEvent.click(view.getByRole('button', { name: 'Open full screen' }))
    expect(JSON.parse(view.container.querySelector('output')?.textContent ?? '{}')).toEqual({
      path: artifactPath(artifact.id),
      panelId: null,
    })
    await settle()
  })

  it('persists a pin through a new mount without changing display mode', async () => {
    const artifact = htmlArtifact('pin')
    const view = renderControls(artifact)
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Pin artifact' }))
    await settle()
    expect((await getArtifactPinsQuery(getDb(), artifact.id))[0]?.value).toBe('true')
    expect(JSON.parse(view.container.querySelector('output')?.textContent ?? '{}').path).toBe('/chats/source-chat')
    view.unmount()
    const reopened = renderControls(artifact)
    await settle()
    expect(reopened.getByRole('button', { name: 'Unpin artifact' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('unpins with a retained preference instead of removing the artifact', async () => {
    const artifact = htmlArtifact('unpin')
    await setArtifactPinned(getDb(), artifact.id, true)
    const view = renderControls(artifact)
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Unpin artifact' }))
    await settle()
    expect((await getArtifactPinsQuery(getDb(), artifact.id))[0]?.value).toBe('false')
    expect(view.getByRole('button', { name: 'Open full screen' })).toBeInTheDocument()
  })

  it('reports a pin write failure and allows retry', async () => {
    const artifact = htmlArtifact('retry')
    const view = renderControls(artifact)
    await settle()
    const transaction = spyOn(getDb(), 'transaction').mockRejectedValueOnce(new Error('Database unavailable'))
    fireEvent.click(view.getByRole('button', { name: 'Pin artifact' }))
    await settle()
    expect(view.getByRole('alert').textContent).toContain('Try again')
    transaction.mockRestore()
    fireEvent.click(view.getByRole('button', { name: 'Pin artifact' }))
    await settle()
    expect((await getArtifactPinsQuery(getDb(), artifact.id))[0]?.value).toBe('true')
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('offers the same display and pin controls for hosted apps without HTML source actions', async () => {
    const reference = { kind: 'remote', appId: 'finance' } as const
    const artifact: Artifact = {
      id: artifactId(reference),
      reference,
      title: 'Finance',
      chatThreadId: null,
      source: {
        kind: 'remote',
        app: {
          id: 'finance',
          name: 'Finance',
          description: '',
          icon: AppWindow,
          url: 'https://example.test',
          origin: 'https://example.test',
        },
      },
    }
    const view = renderControls(artifact)
    await settle()
    expect(view.queryByTitle('Copy HTML')).toBeNull()
    expect(view.queryByTitle('Download HTML')).toBeNull()
    expect(view.getByRole('button', { name: 'Pin artifact' })).toBeInTheDocument()
    fireEvent.click(view.getByRole('button', { name: 'Open in side panel' }))
    expect(view.container.querySelector('output')?.textContent).toContain(artifact.id)
  })

  it('lets the full-page host move to a conversation when opening the panel', async () => {
    const openPanel = mock(() => {})
    const view = renderControls(htmlArtifact('override'), 'fullscreen', openPanel)
    expect(view.queryByRole('button', { name: 'Open full screen' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Open in side panel' }))
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(JSON.parse(view.container.querySelector('output')?.textContent ?? '{}').panelId).toBeNull()
    await settle()
  })

  it('lets a sidebar workspace return to full screen without replacing its conversation route', async () => {
    const openFullScreen = mock(() => {})
    const view = renderControls(htmlArtifact('keep-chat'), 'sidebar', undefined, openFullScreen)
    fireEvent.click(view.getByRole('button', { name: 'Open full screen' }))
    expect(openFullScreen).toHaveBeenCalledTimes(1)
    expect(JSON.parse(view.container.querySelector('output')?.textContent ?? '{}').path).toBe('/chats/source-chat')
    await settle()
  })
})
