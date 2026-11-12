/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { usePageStore } from '@/pages/page-store'
import { ContentViewProvider } from '@/content-view/context'
import { resetAppSettledForTests } from '@/hooks/use-app-settled'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { artifactSandbox } from '@/artifacts/harness-protocol'
import { indexPagePublications } from '@/pages/page-publications'
import { PagePublicationsContext } from '@/pages/page-publications-context'
import { ArtifactMessagePart } from './artifact-message-part'

type PartOverrides = {
  toolCallId: string
  state: string
  output?: unknown
  html?: string
  title?: string
  presentation?: 'inline' | 'sidebar'
  pageId?: string
}

const toolPart = (overrides: PartOverrides): ToolOrDynamicToolUIPart =>
  ({
    type: 'tool-render_html',
    toolCallId: overrides.toolCallId,
    state: overrides.state,
    input: {
      html: overrides.html ?? '<h1>Hi</h1>',
      title: overrides.title ?? 'My Artifact',
      presentation: overrides.presentation,
      pageId: overrides.pageId,
    },
    ...(overrides.output !== undefined ? { output: overrides.output } : {}),
  }) as unknown as ToolOrDynamicToolUIPart

const renderPart = (part: ToolOrDynamicToolUIPart) =>
  render(
    <ContentViewProvider>
      <ArtifactMessagePart part={part} />
    </ContentViewProvider>,
  )

describe('ArtifactMessagePart', () => {
  let restoreIntersectionObserver: () => void
  beforeEach(() => {
    usePageStore.setState({ sessions: [], activeId: null })
    restoreIntersectionObserver = mockIntersectionObserver(true)
    resetAppSettledForTests()
  })
  afterEach(() => {
    restoreIntersectionObserver()
    resetAppSettledForTests()
  })

  it('shows a shimmering "Generating" card while streaming, with no blank frame before there is body content', () => {
    const { container } = renderPart(
      toolPart({ toolCallId: 'a1', state: 'input-streaming', html: '', presentation: 'inline' }),
    )
    expect(container.textContent).toContain('Generating')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('reveals the live preview once the streaming HTML has body content', () => {
    const { container } = renderPart(
      toolPart({
        toolCallId: 'a1b',
        state: 'input-streaming',
        html: '<body><h1>Hi</h1></body>',
        presentation: 'inline',
      }),
    )
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe('') // scripts off during the preview
  })

  it('renders a verified inline artifact, running scripts once visible + settled', async () => {
    const { container } = renderPart(toolPart({ toolCallId: 'a2', state: 'output-available', output: { ok: true } }))
    expect(container.querySelector('[data-page-host] iframe')).toBeNull()
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe(artifactSandbox)
    expect(container.textContent).toContain('My Artifact')
  })

  it('moves the display slot without replacing the running iframe between inline and sidebar', async () => {
    const { container, getByTitle } = renderPart(
      toolPart({ toolCallId: 'a3', state: 'output-available', output: { ok: true } }),
    )
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    const frame = container.querySelector('[data-page-host] iframe')
    expect(frame).not.toBeNull()
    const sessionId = usePageStore.getState().sessions[0].id
    act(() => {
      fireEvent.click(getByTitle('Open in side panel'))
    })
    expect(container.querySelectorAll('[data-page-host] iframe')).toHaveLength(1)
    expect(container.querySelector('[data-page-host] iframe')).toBe(frame)
    expect(container.textContent).toBe('')
    expect(usePageStore.getState().sessions[0].presentation).toBe('sidebar')
    act(() => {
      usePageStore.getState().present(sessionId, 'inline')
    })
    expect(container.querySelector('[data-page-host] iframe')).toBe(frame)
    expect(usePageStore.getState().sessions[0].id).toBe(sessionId)
    expect(usePageStore.getState().sessions[0].presentation).toBe('inline')
  })

  it('collapses to just the header when the header is clicked (open by default)', () => {
    const { container } = renderPart(toolPart({ toolCallId: 'a5', state: 'output-available', output: { ok: true } }))
    const header = container.querySelector('[aria-expanded]')
    expect(header?.getAttribute('aria-expanded')).toBe('true')
    act(() => {
      fireEvent.click(header as Element)
    })
    expect(header?.getAttribute('aria-expanded')).toBe('false')
  })

  it('leaves the header inert while generating (no collapse affordance)', () => {
    const { container } = renderPart(
      toolPart({
        toolCallId: 'a6',
        state: 'input-streaming',
        html: '<body><h1>Hi</h1></body>',
        presentation: 'inline',
      }),
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

  it('renders no chat widget while generating a sidebar app', () => {
    const { container } = renderPart(
      toolPart({ toolCallId: 'app-stream', state: 'input-streaming', html: '<h1>App</h1>' }),
    )
    expect(container.textContent).toBe('')
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('renders no chat widget or session for a restored sidebar publication', async () => {
    const { container } = renderPart(
      toolPart({
        toolCallId: 'app',
        state: 'output-available',
        output: { ok: true, pageId: 'app-page', presentation: 'sidebar' },
      }),
    )
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(usePageStore.getState().sessions).toHaveLength(0)
    expect(container.textContent).toBe('')
    expect(container.querySelector('[data-page-slot]')).toBeNull()
  })

  it('renders one inline preview with the latest snapshot and no repeated update widgets', async () => {
    const original = toolPart({
      toolCallId: 'original',
      state: 'output-available',
      html: '<h1>Old</h1>',
      output: { ok: true, pageId: 'shared-page', presentation: 'inline' },
    })
    const update = toolPart({
      toolCallId: 'update',
      state: 'output-available',
      html: '<h1>Latest</h1>',
      output: { ok: true, pageId: 'shared-page', presentation: 'inline', updated: false },
    })
    const publications = indexPagePublications([{ id: 'message', role: 'assistant', parts: [original, update] }])
    const { container, getByTitle } = render(
      <ContentViewProvider>
        <PagePublicationsContext value={publications}>
          <ArtifactMessagePart part={original} />
          <ArtifactMessagePart part={update} />
        </PagePublicationsContext>
      </ContentViewProvider>,
    )
    await act(async () => {
      await getClock().tickAsync(1000)
    })
    expect(container.querySelectorAll('[data-page-slot]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-page-update]')).toHaveLength(0)
    expect(usePageStore.getState().sessions).toHaveLength(1)
    expect(usePageStore.getState().sessions[0].page.source).toMatchObject({ html: '<h1>Latest</h1>' })
    fireEvent.click(getByTitle('Open in side panel'))
    expect(container.textContent).toBe('')
    expect(container.querySelectorAll('[data-page-slot]')).toHaveLength(0)
  })

  it('respects the live inline placement and latest source instead of the publication hint', () => {
    const page = {
      id: 'updated-inline',
      title: 'Latest title',
      source: { kind: 'html' as const, html: '<h1>Latest</h1>' },
    }
    usePageStore.getState().ensure(page, { presentation: 'inline' })
    const { container } = renderPart(
      toolPart({
        toolCallId: 'inline-update',
        state: 'output-available',
        output: { ok: true, pageId: page.id, updated: true, presentation: 'sidebar' },
      }),
    )
    expect(container.textContent).toContain('Latest title')
    expect(container.querySelector('[data-page-slot]')).not.toBeNull()
    expect(usePageStore.getState().sessions[0].presentation).toBe('inline')
  })

  it('renders nothing for a failed verification (it stays an ordinary tool call elsewhere)', () => {
    const { container } = renderPart(
      toolPart({ toolCallId: 'a4', state: 'output-available', output: { ok: false, errors: ['boom'] } }),
    )
    expect(container.textContent).toBe('')
  })
})
