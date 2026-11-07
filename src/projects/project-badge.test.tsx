/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useQueryClient } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { useConfigStore } from '@/api/config-store'
import { useChatStore } from '@/chats/chat-store'
import { eq } from 'drizzle-orm'
import { getAllProjects } from '@/dal/projects'
import { getDb } from '@/db/database'
import { chatThreadsTable, projectsTable } from '@/db/tables'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createMockChatInstance, hydrateStore } from '@/test-utils/chat-store-mocks'
import { SidebarProvider } from '@/components/ui/sidebar'
import { useProjectTreeState } from '@/layout/sidebar/use-project-tree-state'
import { useProjectBadgeState } from './use-project-badge-state'
import { ProjectBadge } from './project-badge'
// Keep lazy module I/O outside fake-clock interaction waits.
import './project-editor-dialog'
import './project-create-dialog'

afterEach(() => {
  cleanup()
  restoreViewport()
  localStorage.removeItem('sidebar.projects.expanded')
  useChatStore.setState({ currentSessionId: null, sessions: new Map() })
  useConfigStore.setState({ config: {}, configLoaded: false })
})

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)

/** Put a session in the store with (or without) a project, as hydration would. */
const seedSession = (projectId: string | null) => {
  hydrateStore({
    id: 'chat-1',
    chatInstance: createMockChatInstance(),
    chatThread: null,
    selectedModel: null,
    triggerData: null,
  })
  useChatStore.getState().updateSession('chat-1', { projectId })
}

beforeEach(async () => {
  await resetTestDatabase()
  await getDb().insert(projectsTable).values({ id: 'p1', name: 'Q3 Planning', icon: '📊' })
  useConfigStore.setState({ config: {}, configLoaded: false })
  seedSession('p1')
})

const renderBadge = async (props: { iconOnly?: boolean } = {}) => {
  const view = render(
    <MemoryRouter>
      <ProjectBadge chatThreadId="chat-1" {...props} />
    </MemoryRouter>,
    { wrapper: createTestProvider() },
  )
  await act(async () => {
    await getClock().runAllAsync()
  })
  return view
}

describe('ProjectBadge', async () => {
  it('names the project it is in', async () => {
    await renderBadge()
    expect(screen.getByText('Q3 Planning')).toBeInTheDocument()
  })

  it('renders nothing in minimal mode, though the chat keeps its project', async () => {
    useConfigStore.setState({ config: { minimalMode: true }, configLoaded: true })
    const { container } = await renderBadge()

    expect(container).toBeEmptyDOMElement()
    expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
  })

  it.each([false, true])('offers project selection for an unassigned chat (mobile: %s)', async (mobile) => {
    if (mobile) {
      forceMobileViewport()
    }
    seedSession(null)
    await renderBadge({ iconOnly: mobile })
    const trigger = screen.getByRole('button', { name: 'Choose project' })
    expect(trigger.firstElementChild?.className).toContain('rounded-full')
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'Create Project' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove from project' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Q3 Planning' }))
      await getClock().runAllAsync()
    })
    expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
  })

  it('renders nothing when the chat has no session yet', async () => {
    useChatStore.setState({ currentSessionId: null, sessions: new Map() })
    const { container } = await renderBadge()
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ProjectBadge iconOnly (mobile)', async () => {
  it('drops the name but stays labelled for screen readers', async () => {
    // The mobile header has no room for a second labelled pill, but the control
    // still has to say what it is.
    await renderBadge({ iconOnly: true })
    expect(screen.queryByText('Q3 Planning')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'In project: Q3 Planning' })).toBeInTheDocument()
  })

  it('shows the project’s emoji', async () => {
    await renderBadge({ iconOnly: true })
    const button = screen.getByRole('button', { name: 'In project: Q3 Planning' })
    expect(button.querySelector('img')).toHaveAttribute('src', '/emoji/1f4ca.svg')
    expect(button.querySelector('img')).toHaveAttribute('aria-hidden', 'true')
  })

  it('is a circle sized like the agent control beside it', async () => {
    await renderBadge({ iconOnly: true })
    const button = screen.getByRole('button', { name: 'In project: Q3 Planning' })
    expect(button.firstElementChild?.className).toContain('rounded-full')
    expect(button.firstElementChild?.className).toContain('max-md:size-[var(--touch-height-lg)]')
  })
})

it.each([false, true])(
  'opens project choices and configures a different project without selecting it (mobile: %s)',
  async (mobile) => {
    if (mobile) {
      forceMobileViewport()
    }
    await getDb().insert(projectsTable).values({ id: 'p2', name: 'Research' })
    await renderBadge({ iconOnly: mobile })
    const trigger = screen.getByRole('button', { name: mobile ? 'In project: Q3 Planning' : 'Q3 Planning' })
    fireEvent.click(trigger)
    expect(await waitForElement(() => screen.queryByRole('button', { name: 'Research' }))).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Project settings' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Configure Research' }))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    const editor = await waitForElement(() => screen.queryByRole('dialog', { name: 'Project settings' }))
    expect(within(editor).getByRole('textbox', { name: 'Name' })).toHaveValue('Research')
    expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
  },
)

it.each([false, true])('can cancel or confirm moving to another project (mobile: %s)', async (mobile) => {
  if (mobile) {
    forceMobileViewport()
  }
  await getDb().insert(projectsTable).values({ id: 'p2', name: 'Research' })
  await renderBadge({ iconOnly: mobile })
  const triggerName = mobile ? 'In project: Q3 Planning' : 'Q3 Planning'
  fireEvent.click(screen.getByRole('button', { name: triggerName }))
  fireEvent.click(screen.getByRole('button', { name: 'Research' }))
  const confirmation = screen.getByRole('alertdialog', { name: 'Move session?' })
  expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
  await act(async () => {
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
    await getClock().runAllAsync()
  })
  expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
  expect(screen.queryByRole('alertdialog')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: triggerName }))
  fireEvent.click(screen.getByRole('button', { name: 'Research' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    await getClock().runAllAsync()
  })
  expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p2')
})

it('closes a pending move when a synced deletion reaches the project list', async () => {
  await getDb().insert(projectsTable).values({ id: 'p2', name: 'Research' })
  const { result } = renderHook(() => ({ badge: useProjectBadgeState('chat-1'), queries: useQueryClient() }), {
    wrapper: createTestProvider(),
  })
  await act(async () => {
    await getClock().runAllAsync()
  })
  act(() => result.current.badge.requestProjectChange('p2'))
  expect(result.current.badge.dialog?.type).toBe('move')
  await act(async () => {
    await getDb().update(projectsTable).set({ deletedAt: '2026-11-02T12:00:00Z' }).where(eq(projectsTable.id, 'p2'))
    await result.current.queries.invalidateQueries({ queryKey: ['projects'] })
    await getClock().runAllAsync()
  })
  expect(result.current.badge.dialog).toBeNull()
  expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
})

it.each([false, true])(
  'rejects a deleted move target before the picker refreshes (persisted: %s)',
  async (persisted) => {
    await getDb().insert(projectsTable).values({ id: 'p2', name: 'Research' })
    if (persisted) {
      await getDb().insert(chatThreadsTable).values({ id: 'chat-1', title: 'Keep', projectId: 'p1' })
    }
    await renderBadge()
    fireEvent.click(screen.getByRole('button', { name: 'Q3 Planning' }))
    fireEvent.click(screen.getByRole('button', { name: 'Research' }))
    const confirm = screen.getByRole('button', { name: 'Move' })
    // Simulate an incoming sync write without refreshing the projects query yet.
    await getDb().update(projectsTable).set({ deletedAt: '2026-11-02T12:00:00Z' }).where(eq(projectsTable.id, 'p2'))
    await act(async () => {
      fireEvent.click(confirm)
      await getClock().runAllAsync()
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
    const threads = await getDb().select().from(chatThreadsTable)
    expect(threads).toEqual(persisted ? [expect.objectContaining({ projectId: 'p1' })] : [])
  },
)

it.each([
  [false, 'p2'],
  [true, 'p2'],
  [false, null],
  [true, null],
] as const)(
  'changes project without losing the chat (persisted: %s, project: %s)',
  async (persisted, targetProjectId) => {
    await getDb().insert(projectsTable).values({ id: 'p2', name: 'Research' })
    if (persisted) {
      await getDb().insert(chatThreadsTable).values({ id: 'chat-1', title: 'Keep this chat', projectId: 'p1' })
    }
    const chatInstance = useChatStore.getState().sessions.get('chat-1')?.chatInstance
    await renderBadge()
    fireEvent.click(screen.getByRole('button', { name: 'Q3 Planning' }))
    await act(async () => {
      fireEvent.click(
        await waitForElement(() =>
          screen.queryByRole('button', { name: targetProjectId ? 'Research' : 'Remove from project' }),
        ),
      )
      await getClock().runAllAsync()
    })
    if (targetProjectId) {
      expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe('p1')
      const confirmation = screen.getByRole('alertdialog', { name: 'Move session?' })
      expect(confirmation).toHaveTextContent('This will move the session to Research.')
      expect(within(confirmation).getByText('Research', { selector: 'strong' })).toBeInTheDocument()
      await act(async () => {
        fireEvent.click(within(confirmation).getByRole('button', { name: 'Move' }))
        await getClock().runAllAsync()
      })
    }
    const session = useChatStore.getState().sessions.get('chat-1')
    expect(session?.projectId).toBe(targetProjectId)
    expect(session?.chatInstance).toBe(chatInstance)
    const chats = await getDb().select().from(chatThreadsTable)
    expect(chats).toEqual(
      persisted ? [expect.objectContaining({ id: 'chat-1', projectId: targetProjectId, title: 'Keep this chat' })] : [],
    )
    if (targetProjectId) {
      expect(screen.getByRole('button', { name: 'Research' })).toHaveAttribute('aria-expanded', 'false')
    } else {
      const trigger = screen.getByRole('button', { name: 'Choose project' })
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(trigger)
      expect(screen.getByRole('button', { name: 'Q3 Planning' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Remove from project' })).toBeNull()
    }
  },
)

it.each([false, true])(
  'creates a project from the picker and assigns the current chat (mobile: %s)',
  async (mobile) => {
    if (mobile) {
      forceMobileViewport()
    }
    await getDb().insert(chatThreadsTable).values({ id: 'chat-1', title: 'Keep this chat', projectId: 'p1' })
    const chatInstance = useChatStore.getState().sessions.get('chat-1')?.chatInstance
    await renderBadge({ iconOnly: mobile })
    const trigger = screen.getByRole('button', { name: mobile ? 'In project: Q3 Planning' : 'Q3 Planning' })
    fireEvent.click(trigger)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create Project' }))
    })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    const form = await waitForElement(() => screen.queryByRole('dialog', { name: 'Create project' }))
    fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), { target: { value: 'New research' } })
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Create' }))
      await getClock().runAllAsync()
    })
    const created = (await getAllProjects(getDb())).find((project) => project.name === 'New research')
    expect(created).toBeDefined()
    expect(useChatStore.getState().sessions.get('chat-1')?.projectId).toBe(created?.id)
    expect(useChatStore.getState().sessions.get('chat-1')?.chatInstance).toBe(chatInstance)
    const [chat] = await getDb().select().from(chatThreadsTable)
    expect(chat).toMatchObject({ id: 'chat-1', title: 'Keep this chat', projectId: created?.id })
    expect(screen.queryByRole('dialog', { name: 'Create project' })).not.toBeInTheDocument()
  },
)

/** Observe the sidebar's real project selection alongside the header picker. */
const DraftProjectProbe = () => {
  const { activeId, state } = useProjectTreeState([], 'new')
  return (
    <output aria-label="Active project" data-expanded={activeId ? state.expanded.has(activeId) : false}>
      {activeId ?? 'none'}
    </output>
  )
}

it.each(['p2', null])('keeps draft sidebar selection in sync when choosing %s', async (targetProjectId) => {
  await getDb().insert(projectsTable).values({ id: 'p2', name: 'Research' })
  render(
    <MemoryRouter initialEntries={['/chats/new?projectId=p1']}>
      <SidebarProvider>
        <DraftProjectProbe />
        <ProjectBadge chatThreadId="chat-1" />
      </SidebarProvider>
    </MemoryRouter>,
    { wrapper: createTestProvider() },
  )
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(screen.getByLabelText('Active project')).toHaveTextContent('p1')
  fireEvent.click(screen.getByRole('button', { name: 'Q3 Planning' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: targetProjectId ? 'Research' : 'Remove from project' }))
    await getClock().runAllAsync()
  })
  if (targetProjectId) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Move' }))
      await getClock().runAllAsync()
    })
  }
  expect(screen.getByLabelText('Active project')).toHaveTextContent(targetProjectId ?? 'none')
  if (targetProjectId) {
    expect(screen.getByLabelText('Active project')).toHaveAttribute('data-expanded', 'true')
  }
})

it('closes project creation when navigating to another chat and does not reopen on return', async () => {
  const view = await renderBadge()
  fireEvent.click(screen.getByRole('button', { name: 'Q3 Planning' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }))
  })
  const form = await waitForElement(() => screen.queryByRole('dialog', { name: 'Create project' }))
  fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), { target: { value: 'For first chat' } })
  act(() => {
    hydrateStore({
      id: 'chat-2',
      chatInstance: createMockChatInstance(),
      chatThread: null,
      selectedModel: null,
      triggerData: null,
    })
  })
  view.rerender(
    <MemoryRouter>
      <ProjectBadge chatThreadId="chat-2" />
    </MemoryRouter>,
  )
  expect(screen.queryByRole('dialog', { name: 'Create project' })).not.toBeInTheDocument()
  expect(useChatStore.getState().sessions.get('chat-2')?.projectId).toBeNull()
  view.rerender(
    <MemoryRouter>
      <ProjectBadge chatThreadId="chat-1" />
    </MemoryRouter>,
  )
  expect(screen.queryByRole('dialog', { name: 'Create project' })).not.toBeInTheDocument()
  expect((await getAllProjects(getDb())).map((project) => project.name)).toEqual(['Q3 Planning'])
})
