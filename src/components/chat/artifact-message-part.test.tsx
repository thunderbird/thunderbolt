/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { ContentViewProvider } from '@/content-view/context'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ArtifactMessagePart } from './artifact-message-part'

type PartOverrides = {
  toolCallId: string
  state: string
  output?: unknown
  errorText?: string
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
    ...(overrides.errorText !== undefined ? { errorText: overrides.errorText } : {}),
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
  })
  afterEach(() => {
    restoreIntersectionObserver()
  })

  it('renders a verified inline artifact, running scripts only after it is visible and the app settles', async () => {
    const { container } = renderPart(
      toolPart({
        toolCallId: 'a1',
        state: 'output-available',
        output: { ok: true, title: 'My Artifact', target: 'inline' },
      }),
    )
    // Scripts stay off until the activation delay elapses.
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('')

    await act(async () => {
      await getClock().tickAsync(2000)
    })

    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(container.textContent).toContain('My Artifact')
  })

  it('renders a side-panel chip (no iframe) for a verified panel artifact', () => {
    const { container } = renderPart(
      toolPart({
        toolCallId: 'a2',
        state: 'output-available',
        output: { ok: true, title: 'My Artifact', target: 'panel' },
      }),
    )
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('Open artifact in side panel')
  })

  it('renders a live, scripts-off preview while the HTML is still streaming', () => {
    const { container } = renderPart(toolPart({ toolCallId: 'a3', state: 'input-streaming' }))
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    // Scripts off during the preview → empty sandbox (no allow-scripts).
    expect(iframe?.getAttribute('sandbox')).toBe('')
    expect(container.textContent).toContain('Generating')
  })

  it('renders nothing before any HTML has streamed in (it stays an ordinary tool call)', () => {
    const { container } = renderPart(toolPart({ toolCallId: 'a4', state: 'input-streaming', html: '' }))
    expect(container.textContent).toBe('')
  })

  it('renders nothing for a failed verification (it stays an ordinary tool call elsewhere)', () => {
    const { container } = renderPart(
      toolPart({ toolCallId: 'a5', state: 'output-available', output: { ok: false, errors: ['boom'] } }),
    )
    expect(container.textContent).toBe('')
  })
})
