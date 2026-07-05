/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { ContentViewProvider } from '@/content-view/context'
import { resetAppSettledForTests } from '@/hooks/use-app-settled'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ArtifactMessagePart } from './artifact-message-part'

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

const renderPart = (part: ToolOrDynamicToolUIPart) =>
  render(
    <ContentViewProvider>
      <ArtifactMessagePart part={part} />
    </ContentViewProvider>,
  )

describe('ArtifactMessagePart', () => {
  let restoreIntersectionObserver: () => void
  beforeEach(() => {
    restoreIntersectionObserver = mockIntersectionObserver(true)
    resetAppSettledForTests()
  })
  afterEach(() => {
    restoreIntersectionObserver()
    resetAppSettledForTests()
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
})
