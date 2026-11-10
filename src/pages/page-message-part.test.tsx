/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, fireEvent, render } from '@testing-library/react'
import type { PageDefinition } from '@shared/page-protocol'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import { mountMessageParts } from '@/components/chat/assistant-message'
import { resetAppSettledForTests } from '@/hooks/use-app-settled'
import { getClock } from '@/testing-library'
import { mockIntersectionObserver } from '@/test-utils/mock-intersection-observer'
import * as verification from '@/artifacts/verify-html'
import * as platform from '@/lib/platform'
import { useLocalAppStore } from '@/local-apps/local-app-store'
import { PageMessagePart } from './page-message-part'
import { usePageStore } from './page-store'

const published = (page: PageDefinition): ToolOrDynamicToolUIPart => ({
  type: 'dynamic-tool',
  toolName:
    page.source.kind === 'html' ? 'page_show_file' : page.source.kind === 'local-app' ? 'local_app' : 'page_open',
  toolCallId: 'published-1',
  state: 'output-available',
  input: { action: 'create' },
  output: { ok: true, page, status: 'ready' },
})
const htmlPage: PageDefinition = {
  id: 'html-1',
  title: 'Interactive page',
  source: { kind: 'html', html: '<h1>Hello</h1>' },
}

let restoreIntersectionObserver: () => void
beforeEach(() => {
  restoreIntersectionObserver = mockIntersectionObserver(true)
  usePageStore.setState({ sessions: [], activeId: null })
  resetAppSettledForTests()
})
afterEach(() => {
  restoreIntersectionObserver()
  usePageStore.setState({ sessions: [], activeId: null })
  resetAppSettledForTests()
})

describe('PageMessagePart', () => {
  it('renders a web external result as an isolated new-tab link without mounting an embed', () => {
    const part = published({ id: 'external-1', title: 'Example', source: { kind: 'url', url: 'https://example.com' } })
    const { getByRole, container } = render(<>{mountMessageParts([part], false, 'message-1', {})}</>)
    const link = getByRole('link', { name: 'Open in your browser' })
    expect(link.getAttribute('href')).toBe('https://example.com')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(container.querySelector('iframe, [data-page-slot]')).toBeNull()
    expect(usePageStore.getState().sessions).toHaveLength(0)
  })

  it('explains a local app is tied to its owning desktop without launching it', () => {
    const { getByText, queryByTitle } = render(
      <PageMessagePart
        part={published({ id: 'local-app:one', title: 'Local app', source: { kind: 'local-app', appId: 'one' } })}
        messageId="message-1"
      />,
    )
    expect(getByText(/Its files do not sync/)).toBeTruthy()
    expect(queryByTitle('Open in side panel')).toBeNull()
    expect(usePageStore.getState().sessions).toHaveLength(0)
  })

  it('moves a live page between transcript and browser without replacing its session', () => {
    const id = usePageStore.getState().ensure(htmlPage, { presentation: 'sidebar' })
    const { getByRole, getByTitle, container } = render(
      <PageMessagePart part={published(htmlPage)} messageId="message-1" />,
    )
    expect(container.querySelector('[data-page-slot]')).toBeNull()
    act(() => {
      fireEvent.click(getByRole('button', { name: 'Show inline' }))
    })
    expect(container.querySelector('[data-page-slot]')?.getAttribute('data-page-slot')).toBe(id)
    act(() => {
      fireEvent.click(getByTitle('Open in side panel'))
    })
    expect(usePageStore.getState().sessions).toHaveLength(1)
    expect(usePageStore.getState().sessions[0]?.id).toBe(id)
    expect(usePageStore.getState().sessions[0]?.presentation).toBe('sidebar')
  })

  it('shows and clears late runtime errors from the shared inline HTML session', () => {
    const id = usePageStore.getState().ensure(htmlPage, { presentation: 'inline' })
    const { getAllByText, queryByText, container } = render(
      <PageMessagePart part={published(htmlPage)} messageId="message-1" />,
    )
    act(() => usePageStore.getState().update(id, { error: 'Late runtime failure' }))
    expect(getAllByText('Late runtime failure')).toHaveLength(1)
    expect(container.querySelector('[data-page-slot]')?.getAttribute('data-page-slot')).toBe(id)
    act(() => usePageStore.getState().update(id, { error: null }))
    expect(queryByText('Late runtime failure')).toBeNull()
    expect(container.querySelector('[data-page-slot]')?.getAttribute('data-page-slot')).toBe(id)
  })

  it('never auto-launches a restored local recipe on its owning desktop, even when scrolled into view', async () => {
    const native = spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
    const previous = useLocalAppStore.getState().apps
    useLocalAppStore.getState().save({
      id: 'one',
      owner: { kind: 'chat', id: 'original-chat' },
      title: 'Local app',
      cwd: '/project',
      launch: { executable: 'bun', args: ['start'] },
      createdAt: new Date().toISOString(),
    })
    try {
      const { getByRole, queryByText, container } = render(
        <PageMessagePart
          part={published({
            id: 'local-app:one',
            title: 'Local app',
            source: { kind: 'local-app', appId: 'one' },
          })}
          messageId="imported-message"
        />,
      )
      await act(async () => {
        await getClock().tickAsync(1001)
      })
      expect(usePageStore.getState().sessions).toHaveLength(0)
      expect(container.querySelector('[data-page-slot]')).toBeNull()
      fireEvent.click(getByRole('button', { name: 'Open local app' }))
      expect(usePageStore.getState().sessions).toHaveLength(1)
      expect(usePageStore.getState().sessions[0].presentation).toBe('sidebar')
      expect(queryByText('Shown in browser')).toBeTruthy()
    } finally {
      native.mockRestore()
      useLocalAppStore.setState({ apps: previous })
    }
  })

  it('verifies a restored HTML snapshot before creating its live session', async () => {
    const verify = spyOn(verification, 'verifyArtifactHtml').mockResolvedValue({ ok: true, errors: [] })
    try {
      const { getByText } = render(<PageMessagePart part={published(htmlPage)} messageId="message-1" />)
      expect(getByText('Checking this page…')).toBeTruthy()
      expect(usePageStore.getState().sessions).toHaveLength(0)
      await act(async () => {
        await getClock().tickAsync(1001)
      })
      expect(verify).toHaveBeenCalledTimes(1)
      expect(usePageStore.getState().sessions[0]?.page.id).toBe(htmlPage.id)
    } finally {
      verify.mockRestore()
    }
  })

  it('keeps rejected restored HTML out of all live renderers', async () => {
    const verify = spyOn(verification, 'verifyArtifactHtml').mockResolvedValue({
      ok: false,
      errors: ['Invalid JavaScript'],
    })
    try {
      const { getByText } = render(<PageMessagePart part={published(htmlPage)} messageId="message-1" />)
      await act(async () => {
        await getClock().tickAsync(1001)
      })
      expect(getByText('Invalid JavaScript')).toBeTruthy()
      expect(usePageStore.getState().sessions).toHaveLength(0)
    } finally {
      verify.mockRestore()
    }
  })
})
