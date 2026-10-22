/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, spyOn } from 'bun:test'
import { act, cleanup, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { artifactId, artifactPath } from '@/artifacts/artifact'
import { SidebarProvider } from '@/components/ui/sidebar'
import { HttpClientProvider } from '@/contexts/http-client-context'
import { artifactPinKey, setArtifactPinned } from '@/dal/artifacts'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, settingsTable } from '@/db/tables'
import { resetMiniAppsForTesting } from '@/mini-apps/use-mini-apps'
import { createMockHttpClient } from '@/test-utils/http-client'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import { ArtifactSection } from './artifact-section'

const artifacts = Array.from({ length: 12 }, (_, index) => {
  const toolCallId = `call-${index + 1}`
  return {
    id: artifactId({ kind: 'html', messageId: 'message', toolCallId }),
    toolCallId,
    title: `Artifact ${index + 1}`,
  }
}).sort((a, b) => (a.id < b.id ? -1 : 1))

const Fixture = ({ collapsed }: { collapsed: boolean }) => {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <ArtifactSection pathname={location.pathname} isCollapsed={collapsed} onNavigate={navigate} />
      <output aria-label="Location">{location.pathname + location.search}</output>
    </>
  )
}

const renderSection = (collapsed = false, path = '/chats/current?projectId=project', remote = false) => {
  const httpClient = createMockHttpClient({
    apps: remote
      ? [
          {
            id: 'finance',
            name: 'Finance',
            description: '',
            icon: '',
            url: 'https://finance.example/app',
            origin: 'https://finance.example',
          },
        ]
      : [],
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HttpClientProvider httpClient={httpClient}>
      <MemoryRouter initialEntries={[path]}>
        <SidebarProvider defaultOpen={!collapsed}>{children}</SidebarProvider>
      </MemoryRouter>
    </HttpClientProvider>
  )
  return renderWithReactivity(<Fixture collapsed={collapsed} />, {
    wrapper,
    tables: ['settings', 'chat_messages', 'chat_threads'],
  })
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
      parts: artifacts.map((artifact) => ({
        type: 'dynamic-tool' as const,
        toolName: 'render_html',
        toolCallId: artifact.toolCallId,
        state: 'output-available' as const,
        input: { title: artifact.title, html: '<p>Artifact</p>' },
        output: { ok: true },
      })),
    })
  for (const artifact of artifacts) {
    await setArtifactPinned(getDb(), artifact.id, true)
  }
})
afterEach(() => {
  cleanup()
  resetMiniAppsForTesting()
  restoreViewport()
})

it.each([false, true])(
  'collapses pins without navigation and retains the expanded preview (mobile: %s)',
  async (mobile) => {
    if (mobile) {
      forceMobileViewport()
    }
    const view = renderSection()
    await waitForElement(() => view.queryByRole('button', { name: artifacts[0].title }))
    expect(view.getAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(5)
    fireEvent.click(view.getByRole('button', { name: 'Show more artifacts' }))
    expect(view.getAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(10)
    const toggle = view.getByRole('button', { name: 'Artifacts' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(view.queryAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(0)
    expect(view.getByRole('status', { name: 'Location' })).toHaveTextContent('/chats/current?projectId=project')
    expect(view.queryByRole('button', { name: 'Browse artifacts' })).toBeNull()
    fireEvent.click(toggle)
    expect(view.getAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(10)
    fireEvent.click(view.getByRole('button', { name: 'Show more artifacts' }))
    expect(view.getAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(12)
    fireEvent.click(view.getByRole('button', { name: 'Show fewer artifacts' }))
    expect(view.getAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(5)
  },
)

it('keeps the selected artifact in the preview and follows live unpinning', async () => {
  const selected = artifacts[11]
  const view = renderSection(false, artifactPath(selected.id))
  const row = await waitForElement(() => view.queryByRole('button', { name: selected.title }))
  expect(row).toHaveAttribute('data-active', 'true')
  expect(view.getAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(5)
  await setArtifactPinned(getDb(), selected.id, false)
  view.triggerChange(['settings'])
  await settle()
  expect(view.queryByRole('button', { name: selected.title })).toBeNull()
  expect(view.getByRole('status', { name: 'Location' })).toHaveTextContent(artifactPath(selected.id))
})

it('keeps one rail button and reveals more pins without closing its dropdown', async () => {
  const view = renderSection(true)
  await settle()
  const trigger = view.getByRole('button', { name: 'Artifacts' })
  expect(view.queryAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(0)
  fireEvent.keyDown(trigger, { key: 'Enter' })
  await waitForElement(() => view.queryByRole('menuitem', { name: artifacts[0].title }))
  expect(view.getAllByRole('menuitem', { name: /^Artifact \d+$/ })).toHaveLength(5)
  fireEvent.click(view.getByRole('menuitem', { name: 'Show more' }))
  expect(view.getAllByRole('menuitem', { name: /^Artifact \d+$/ })).toHaveLength(10)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(view.getByRole('menuitem', { name: artifacts[8].title }))
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(view.getByRole('status', { name: 'Location' })).toHaveTextContent(artifactPath(artifacts[8].id))
})

it('shows a simple empty section when there are no pins', async () => {
  for (const artifact of artifacts) {
    await setArtifactPinned(getDb(), artifact.id, false)
  }
  const view = renderSection()
  expect(await waitForElement(() => view.queryByText('Pin artifacts to keep them here.'))).toBeVisible()
  expect(view.queryByRole('button', { name: 'Browse artifacts' })).toBeNull()
  expect(view.queryAllByRole('button', { name: /^Artifact \d+$/ })).toHaveLength(0)
})

it.each([false, true])('renames through the context menu without navigating (collapsed: %s)', async (collapsed) => {
  const view = renderSection(collapsed)
  await settle()
  if (collapsed) {
    fireEvent.keyDown(view.getByRole('button', { name: 'Artifacts' }), { key: 'Enter' })
  }
  const row = await waitForElement(() =>
    view.queryByRole(collapsed ? 'menuitem' : 'button', { name: artifacts[0].title }),
  )
  fireEvent.contextMenu(row)
  expect(view.getByRole('menuitem', { name: 'Open artifact' })).toBeVisible()
  expect(view.getByRole('menuitem', { name: 'Open source chat' })).toBeVisible()
  fireEvent.click(view.getByRole('menuitem', { name: 'Rename' }))
  await settle()
  const input = view.getByRole('textbox', { name: 'Artifact name' })
  expect(input).toHaveFocus()
  expect(input).toHaveValue(artifacts[0].title)
  fireEvent.change(input, { target: { value: 'Renamed artifact' } })
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
  })
  view.triggerChange(['settings'])
  await settle()
  expect(view.queryByRole('dialog', { name: 'Rename artifact' })).toBeNull()
  if (collapsed && view.getByRole('button', { name: 'Artifacts' }).getAttribute('aria-expanded') !== 'true') {
    fireEvent.keyDown(view.getByRole('button', { name: 'Artifacts' }), { key: 'Enter' })
  }
  expect(view.getByRole(collapsed ? 'menuitem' : 'button', { name: 'Renamed artifact' })).toBeVisible()
  expect(view.getByRole('status', { name: 'Location' })).toHaveTextContent('/chats/current?projectId=project')
  const messages = await getDb().select().from(chatMessagesTable)
  expect(messages[0].parts).toContainEqual(
    expect.objectContaining({ input: { title: artifacts[0].title, html: '<p>Artifact</p>' } }),
  )
})

it.each(['Open artifact', 'Open source chat'])('navigates only after choosing %s', async (action) => {
  const view = renderSection()
  const row = await waitForElement(() => view.queryByRole('button', { name: artifacts[0].title }))
  const location = view.getByRole('status', { name: 'Location' })
  fireEvent.contextMenu(row)
  expect(location).toHaveTextContent('/chats/current?projectId=project')
  fireEvent.click(view.getByRole('menuitem', { name: action }))
  expect(view.getByRole('status', { name: 'Location' })).toHaveTextContent(
    action === 'Open artifact' ? artifactPath(artifacts[0].id) : '/chats/chat?view=chat',
  )
})

it.each([false, true])(
  'unpins without deleting content or changing the open route (collapsed: %s)',
  async (collapsed) => {
    const path = artifactPath(artifacts[0].id)
    const view = renderSection(collapsed, path)
    await settle()
    if (collapsed) {
      fireEvent.keyDown(view.getByRole('button', { name: 'Artifacts' }), { key: 'Enter' })
    }
    const row = await waitForElement(() =>
      view.queryByRole(collapsed ? 'menuitem' : 'button', { name: artifacts[0].title }),
    )
    fireEvent.contextMenu(row)
    await act(async () => {
      fireEvent.click(view.getByRole('menuitem', { name: 'Unpin artifact' }))
    })
    view.triggerChange(['settings'])
    await settle()
    expect(view.queryByRole(collapsed ? 'menuitem' : 'button', { name: artifacts[0].title })).toBeNull()
    expect(view.getByRole('status', { name: 'Location' })).toHaveTextContent(path)
    const settings = await getDb().select().from(settingsTable)
    expect(settings.find(({ key }) => key === artifactPinKey(artifacts[0].id))?.value).toBe('false')
    expect(await getDb().select().from(chatMessagesTable)).toHaveLength(1)
    expect(await getDb().select().from(chatThreadsTable)).toHaveLength(1)
  },
)

it('keeps a failed rename draft and allows retry', async () => {
  const view = renderSection()
  const row = await waitForElement(() => view.queryByRole('button', { name: artifacts[0].title }))
  fireEvent.contextMenu(row)
  fireEvent.click(view.getByRole('menuitem', { name: 'Rename' }))
  fireEvent.change(view.getByRole('textbox', { name: 'Artifact name' }), { target: { value: 'Retry title' } })
  const write = spyOn(getDb(), 'transaction').mockRejectedValueOnce(new Error('Write failed'))
  try {
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Save' }))
    })
    expect(view.getByRole('alert')).toHaveTextContent('Could not rename the artifact')
    expect(view.getByRole('textbox', { name: 'Artifact name' })).toHaveValue('Retry title')
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Save' }))
    })
    view.triggerChange(['settings'])
    await settle()
    expect(view.queryByRole('dialog', { name: 'Rename artifact' })).toBeNull()
    expect(view.getByRole('button', { name: 'Retry title' })).toBeVisible()
    expect(view.queryByRole('alert')).toBeNull()
  } finally {
    write.mockRestore()
  }
})

it('keeps the pin after a failed write and clears feedback after retry', async () => {
  const view = renderSection()
  const row = await waitForElement(() => view.queryByRole('button', { name: artifacts[0].title }))
  fireEvent.contextMenu(row)
  const write = spyOn(getDb(), 'transaction').mockRejectedValueOnce(new Error('Write failed'))
  try {
    await act(async () => {
      fireEvent.click(view.getByRole('menuitem', { name: 'Unpin artifact' }))
    })
    expect(view.getByRole('alert')).toHaveTextContent('Could not update the artifact pin')
    expect(view.getByRole('button', { name: artifacts[0].title })).toBeVisible()
    fireEvent.contextMenu(row)
    await act(async () => {
      fireEvent.click(view.getByRole('menuitem', { name: 'Unpin artifact' }))
    })
    view.triggerChange(['settings'])
    await settle()
    expect(view.queryByRole('button', { name: artifacts[0].title })).toBeNull()
    expect(view.queryByRole('alert')).toBeNull()
  } finally {
    write.mockRestore()
  }
})

it('offers remote artifacts the same actions without a nonexistent source chat', async () => {
  const id = artifactId({ kind: 'remote', appId: 'finance' })
  await setArtifactPinned(getDb(), id, true)
  const view = renderSection(false, artifactPath(id), true)
  const row = await waitForElement(() => view.queryByRole('button', { name: 'Finance' }))
  fireEvent.contextMenu(row)
  expect(view.queryByRole('menuitem', { name: 'Open source chat' })).toBeNull()
  expect(view.getByRole('menuitem', { name: 'Open artifact' })).toBeVisible()
  expect(view.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
  expect(view.getByRole('menuitem', { name: 'Unpin artifact' })).toBeVisible()
})
