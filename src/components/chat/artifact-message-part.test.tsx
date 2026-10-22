/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { getDb } from '@/db/database'
import { renameProjectArtifact } from '@/dal/project-artifact-presentation'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import { artifactId, artifactPath } from '@/artifacts/artifact'
import { getActiveArtifactSession } from '@/artifacts/artifact-session-store'
import { usePendingQuotesStore } from '@/chats/pending-quotes-store'
import type { ReactNode } from 'react'
import { resetAppSettledForTests } from '@/hooks/use-app-settled'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'
import { act, fireEvent, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { ArtifactMessagePart } from './artifact-message-part'
import { ArtifactCanvasContext } from '@/artifacts/artifact-canvas-context'

type PartOverrides = {
  toolCallId: string
  state: string
  output?: unknown
  html?: string
  title?: string
}

const toolPart = (overrides: PartOverrides): ToolOrDynamicToolUIPart =>
  ({
    type: 'tool-render_html',
    toolCallId: overrides.toolCallId,
    state: overrides.state,
    input: { html: overrides.html ?? '<h1>Hi</h1>', title: overrides.title ?? 'My Artifact' },
    ...(overrides.output !== undefined ? { output: overrides.output } : {}),
  }) as unknown as ToolOrDynamicToolUIPart

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

const renderWithProviders = (children: ReactNode, path = '/') => {
  const Provider = createTestProvider()
  return render(
    <Provider>
      <MemoryRouter initialEntries={[path]}>
        <ContentViewProvider>
          <Routes>
            <Route path="/artifacts/:artifactId" element={children} />
            <Route path="*" element={children} />
          </Routes>
        </ContentViewProvider>
      </MemoryRouter>
    </Provider>,
  )
}

const renderPart = (part: ToolOrDynamicToolUIPart) =>
  renderWithProviders(<ArtifactMessagePart part={part} messageId="message-one" chatThreadId="chat-one" />)

const PanelIdentity = () => {
  const { state } = useContentView()
  return (
    <output>
      {state.type === 'artifact' ? JSON.stringify({ id: state.data.id, chatThreadId: state.data.chatThreadId }) : ''}
    </output>
  )
}

describe('ArtifactMessagePart', () => {
  it('keeps an artifact in its project canvas when the source chat opens', () => {
    const actions: string[] = []
    const { container, getByText } = renderWithProviders(
      <ArtifactCanvasContext
        value={{ messageId: 'canvas-message', toolCallId: 'canvas', reveal: () => actions.push('reveal') }}
      >
        <ArtifactMessagePart
          part={toolPart({ toolCallId: 'canvas', state: 'output-available', output: { ok: true } })}
          messageId="canvas-message"
          chatThreadId="canvas-chat"
        />
      </ArtifactCanvasContext>,
    )
    expect(container.querySelector('iframe')).toBeNull()
    fireEvent.click(getByText('Show artifact'))
    expect(actions).toEqual(['reveal'])
  })
  let restoreIntersectionObserver: () => void
  beforeEach(() => {
    restoreIntersectionObserver = mockIntersectionObserver(true)
    resetAppSettledForTests()
    usePendingQuotesStore.setState({ quotesByThread: {} })
  })
  afterEach(() => {
    restoreIntersectionObserver()
    resetAppSettledForTests()
  })

  it('keeps saved names consistent when returning from the side panel to inline', async () => {
    const id = artifactId({ kind: 'html', messageId: 'renamed-message', toolCallId: 'renamed-call' })
    await renameProjectArtifact(getDb(), id, 'Saved name')
    const view = renderWithReactivity(
      <MemoryRouter>
        <ContentViewProvider>
          <ArtifactMessagePart
            part={toolPart({ toolCallId: 'renamed-call', state: 'output-available', output: { ok: true } })}
            messageId="renamed-message"
            chatThreadId="chat-one"
          />
        </ContentViewProvider>
      </MemoryRouter>,
      { tables: ['settings'] },
    )
    await waitForElement(() => view.queryByText('Saved name'))
    fireEvent.click(view.getByTitle('Open in side panel'))
    await act(async () => {
      await renameProjectArtifact(getDb(), id, 'Updated name')
      view.triggerChange(['settings'])
      await getClock().tickAsync(200)
    })
    fireEvent.click(view.getByText('Show inline'))
    expect(view.getByText('Updated name')).toBeInTheDocument()
    expect(view.queryByText('My Artifact')).toBeNull()
    expect(view.container.querySelector('iframe')).not.toBeNull()
  })

  it('shows a shimmering "Generating" card while streaming, with no blank frame before there is body content', () => {
    const { container } = renderPart(toolPart({ toolCallId: 'a1', state: 'input-streaming', html: '' }))
    expect(container.textContent).toContain('Generating')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('reveals the live preview once the streaming HTML has body content', () => {
    const { container } = renderPart(
      toolPart({ toolCallId: 'a1b', state: 'input-streaming', html: '<body><h1>Hi</h1></body>' }),
    )
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('') // scripts off during the preview
  })

  it('renders a verified inline artifact, running scripts once visible + settled', async () => {
    const { container } = renderPart(toolPart({ toolCallId: 'a2', state: 'output-available', output: { ok: true } }))
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(container.textContent).toContain('My Artifact')
  })

  it('toggles between inline and the side panel — never both at once', () => {
    const { container, getByTitle, getByText } = renderPart(
      toolPart({ toolCallId: 'a3', state: 'output-available', output: { ok: true } }),
    )
    expect(container.querySelector('iframe')).not.toBeNull()

    // Open in the side panel → the transcript collapses to a slim placeholder (no iframe).
    act(() => {
      fireEvent.click(getByTitle('Open in side panel'))
    })
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('shown in side panel')

    // Show inline → the iframe returns.
    act(() => {
      fireEvent.click(getByText('Show inline'))
    })
    expect(container.querySelector('iframe')).not.toBeNull()
  })

  it('releases context when collapsed while preserving the running inline frame', async () => {
    const { container } = renderPart(toolPart({ toolCallId: 'a5', state: 'output-available', output: { ok: true } }))
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    const frame = container.querySelector('iframe')!
    const owner = getActiveArtifactSession()!.owner
    const header = container.querySelector('[aria-expanded]')
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    act(() => {
      fireEvent.click(header as Element)
    })
    expect(header?.getAttribute('aria-expanded')).toBe('false')
    expect(getActiveArtifactSession()).toBeNull()
    expect(container.querySelector('iframe')).toBe(frame)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    fireEvent.click(header as Element)
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    expect(getActiveArtifactSession()?.owner).toBe(owner)
    expect(container.querySelector('iframe')).toBe(frame)
  })

  it('leaves the header inert while generating (no collapse affordance)', () => {
    const { container } = renderPart(
      toolPart({ toolCallId: 'a6', state: 'input-streaming', html: '<body><h1>Hi</h1></body>' }),
    )
    expect(container.querySelector('[aria-expanded]')).toBeNull()
    expect(container.querySelector('[role="button"]')).toBeNull()
  })

  it('exposes copy + download actions once verified, but not while generating', () => {
    const streaming = renderPart(
      toolPart({ toolCallId: 'a7', state: 'input-streaming', html: '<body><h1>Hi</h1></body>' }),
    )
    expect(streaming.queryByTitle('Copy HTML')).toBeNull()
    expect(streaming.queryByTitle('Download HTML')).toBeNull()

    const done = renderPart(toolPart({ toolCallId: 'a7b', state: 'output-available', output: { ok: true } }))
    expect(done.getByTitle('Copy HTML')).not.toBeNull()
    expect(done.getByTitle('Download HTML')).not.toBeNull()
  })

  it('renders nothing for a failed verification (it stays an ordinary tool call elsewhere)', () => {
    const { container } = renderPart(
      toolPart({ toolCallId: 'a4', state: 'output-available', output: { ok: false, errors: ['boom'] } }),
    )
    expect(container.textContent).toBe('')
  })

  it('keeps equal provider tool-call IDs in separate messages independent and carries the owning chat', () => {
    const part = toolPart({ toolCallId: 'shared-call', state: 'output-available', output: { ok: true } })
    const view = renderWithProviders(
      <>
        <ArtifactMessagePart part={part} messageId="first-message" chatThreadId="owning-chat" />
        <ArtifactMessagePart part={part} messageId="second-message" chatThreadId="other-chat" />
        <PanelIdentity />
      </>,
    )
    fireEvent.click(view.getAllByTitle('Open in side panel')[0])
    expect(view.container.querySelectorAll('iframe')).toHaveLength(1)
    expect(view.getAllByText('Show inline')).toHaveLength(1)
    expect(JSON.parse(view.container.querySelector('output')?.textContent ?? '{}')).toEqual({
      id: artifactId({ kind: 'html', messageId: 'first-message', toolCallId: 'shared-call' }),
      chatThreadId: 'owning-chat',
    })
  })

  it('never offers pin or full-screen controls while HTML is unverified', () => {
    const view = renderPart(toolPart({ toolCallId: 'unverified', state: 'input-available' }))
    expect(view.queryByTitle('Pin artifact')).toBeNull()
    expect(view.queryByTitle('Open full screen')).toBeNull()
    expect(view.container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
  })

  it('supports asking about selected inline content in the message’s own conversation', async () => {
    const view = renderPart(toolPart({ toolCallId: 'selection', state: 'output-available', output: { ok: true } }))
    await act(async () => {
      await getClock().tickAsync(1_000)
    })
    const iframe = view.container.querySelector('iframe')
    const nonce = iframe?.srcdoc.match(/var NONCE = "([^"]+)"/)?.[1]
    expect(nonce).toBeDefined()
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe?.contentWindow,
          data: {
            artifactNonce: nonce,
            type: 'artifact-selection',
            selection: { text: 'The selected result', rect: { x: 10, y: 20, width: 120, height: 20 } },
          },
        }),
      )
    })
    fireEvent.click(view.getByRole('button', { name: 'Ask about this' }))
    expect(usePendingQuotesStore.getState().quotesByThread['chat-one'].map((quote) => quote.data.text)).toEqual([
      'The selected result',
    ])
    expect(Object.keys(usePendingQuotesStore.getState().quotesByThread)).toEqual(['chat-one'])
  })

  it.each(['', '?display=sidebar'])(
    'does not duplicate the workspace’s executable frame when its own chat is visible (%s)',
    (search) => {
      const part = toolPart({ toolCallId: 'workspace', state: 'output-available', output: { ok: true } })
      const id = artifactId({ kind: 'html', messageId: 'workspace-message', toolCallId: 'workspace' })
      const view = renderWithProviders(
        <ArtifactMessagePart part={part} messageId="workspace-message" chatThreadId="owning-chat" />,
        artifactPath(id) + search,
      )
      expect(view.container.querySelector('iframe')).toBeNull()
      expect(view.container.textContent).toContain('open beside this chat')
      fireEvent.click(view.getByRole('button', { name: 'Show inline' }))
      expect(view.container.querySelector('iframe')).not.toBeNull()
    },
  )
})
