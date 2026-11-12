/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { PageDefinition } from '@shared/page-protocol'
import type { ToolOrDynamicToolUIPart } from '@/lib/assistant-message'
import * as verification from '@/artifacts/verify-html'
import * as platform from '@/lib/platform'
import { useLocalAppStore } from '@/local-apps/local-app-store'
import { PagePublicationAction } from './page-publication-action'
import { indexPagePublications } from './page-publications'
import { PagePublicationsContext } from './page-publications-context'
import { usePageStore } from './page-store'

const htmlPage: PageDefinition = { id: 'page', title: 'App', source: { kind: 'html', html: '<h1>Old version</h1>' } }
const published = (page = htmlPage, toolCallId = 'create'): ToolOrDynamicToolUIPart => ({
  type: page.source.kind === 'local-app' ? 'tool-local_app' : 'tool-page_show_file',
  state: 'output-available',
  toolCallId,
  input: { action: 'create' },
  output: { ok: true, status: 'ready', page, presentation: 'sidebar' },
})

beforeEach(() => usePageStore.setState({ sessions: [], activeId: null }))
afterEach(() => {
  cleanup()
  usePageStore.setState({ sessions: [], activeId: null })
})

it('reopens the latest verified publication from an earlier tool result after the tab closes', async () => {
  const latest = { ...htmlPage, source: { kind: 'html' as const, html: '<h1>Latest version</h1>' } }
  const publications = indexPagePublications([
    { id: 'first', role: 'assistant', parts: [published()] },
    { id: 'second', role: 'assistant', parts: [published(latest, 'update')] },
  ])
  const verify = spyOn(verification, 'verifyArtifactHtml').mockResolvedValue({ ok: true, errors: [] })
  try {
    const view = render(
      <PagePublicationsContext value={publications}>
        <PagePublicationAction part={published()} />
      </PagePublicationsContext>,
    )
    expect(usePageStore.getState().sessions).toHaveLength(0)
    expect(verify).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Open in side panel' })))
    expect(verify).toHaveBeenCalledWith(latest.source.html)
    expect(usePageStore.getState().sessions[0].page.source).toMatchObject(latest.source)
    const id = usePageStore.getState().sessions[0].id
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Open in side panel' })))
    expect(usePageStore.getState().sessions.map((session) => session.id)).toEqual([id])
    expect(verify).toHaveBeenCalledTimes(1)
  } finally {
    verify.mockRestore()
  }
})

it('preserves a live document newer than the saved transcript', async () => {
  const live = { ...htmlPage, source: { kind: 'html' as const, html: '<h1>Unsaved live revision</h1>' } }
  const id = usePageStore.getState().ensure(live)
  const verify = spyOn(verification, 'verifyArtifactHtml')
  try {
    const view = render(<PagePublicationAction part={published()} />)
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Open in side panel' })))
    expect(usePageStore.getState().sessions[0]).toMatchObject({ id, page: live })
    expect(verify).not.toHaveBeenCalled()
  } finally {
    verify.mockRestore()
  }
})

it('keeps failed verification out of the browser and explains the failure', async () => {
  const verify = spyOn(verification, 'verifyArtifactHtml').mockResolvedValue({ ok: false, errors: ['Syntax error'] })
  try {
    const view = render(<PagePublicationAction part={published()} />)
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Open in side panel' })))
    expect(view.getByRole('alert').textContent).toContain('could not be verified')
    expect(usePageStore.getState().sessions).toHaveLength(0)
  } finally {
    verify.mockRestore()
  }
})

it('restores a local-app host only after a click, including after a reload, and never revives a removed recipe', async () => {
  const native = spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  const previous = useLocalAppStore.getState().apps
  const local: PageDefinition = { id: 'local-app:app', title: 'Local app', source: { kind: 'local-app', appId: 'app' } }
  useLocalAppStore.getState().save({
    id: 'app',
    title: 'Local app',
    owner: { kind: 'chat', id: 'chat' },
    cwd: '/project',
    launch: { executable: 'bun', args: ['start'] },
    createdAt: new Date().toISOString(),
  })
  try {
    const view = render(<PagePublicationAction part={published(local)} />)
    expect(usePageStore.getState().sessions).toHaveLength(0)
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Open in side panel' })))
    expect(usePageStore.getState().sessions[0].page).toEqual(local)
    view.unmount()
    act(() => usePageStore.setState({ sessions: [], activeId: null }))
    const restored = render(<PagePublicationAction part={published(local)} />)
    expect(usePageStore.getState().sessions).toHaveLength(0)
    await act(async () => fireEvent.click(restored.getByRole('button', { name: 'Open in side panel' })))
    expect(usePageStore.getState().sessions).toHaveLength(1)
    act(() => useLocalAppStore.getState().remove('app'))
    expect(restored.getByRole('button').hasAttribute('disabled')).toBe(true)
  } finally {
    native.mockRestore()
    useLocalAppStore.setState({ apps: previous })
  }
})

it('does not offer reopen for a failed publication or an ordinary tool', () => {
  const part = published()
  const view = render(<PagePublicationAction part={{ ...part, output: { ok: false } } as ToolOrDynamicToolUIPart} />)
  expect(view.queryByRole('button')).toBeNull()
  view.rerender(<PagePublicationAction part={{ ...part, type: 'tool-bash' }} />)
  expect(view.queryByRole('button')).toBeNull()
})
