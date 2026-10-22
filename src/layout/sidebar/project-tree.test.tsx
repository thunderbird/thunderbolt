/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { DndContext } from '@dnd-kit/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import { ContentViewProvider } from '@/content-view/context'
import { createProject, getProject } from '@/dal/projects'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createTestProvider } from '@/test-utils/test-provider'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import { ProjectTree } from './project-tree'
import type { ProjectTreeProps } from './project-tree-row'

beforeAll(setupTestDatabase)
beforeEach(resetTestDatabase)
afterEach(() => {
  cleanup()
  restoreViewport()
})
afterAll(teardownTestDatabase)

const tree = (isDragging: boolean, isMobile = false, overrides: Partial<ProjectTreeProps> = {}) => (
  <ProjectTree
    chatThreads={[]}
    isCollapsed={false}
    isMobile={isMobile}
    isDragging={isDragging}
    draggingFromProjectId={null}
    deleteChatMutation={{ mutate: () => {}, isPending: false } as never}
    deleteChatDialogRef={{ current: null }}
    threadIdRef={{ current: null }}
    onChatClick={() => {}}
    onRename={() => {}}
    onMoveToProject={() => {}}
    {...overrides}
  />
)

/** Mount the real project navigation with isolated database and router contexts. */
const createWrapper = () => {
  const TestProvider = createTestProvider()
  return ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <MemoryRouter initialEntries={['/chats/new']}>
        <ContentViewProvider>
          <SidebarProvider>
            <DndContext>{children}</DndContext>
          </SidebarProvider>
        </ContentViewProvider>
      </MemoryRouter>
    </TestProvider>
  )
}

const LocationProbe = () => {
  const location = useLocation()
  return <output aria-label="Location">{location.pathname + location.search}</output>
}

it.each(['context', 'overflow', 'mobile'])(
  'starts a chat from a closed project folder via its %s menu',
  async (menu) => {
    const isMobile = menu === 'mobile'
    if (isMobile) {
      forceMobileViewport()
    }
    const project = await createProject(getDb(), { name: 'Research' })
    render(
      <>
        {tree(false, isMobile)}
        <LocationProbe />
      </>,
      { wrapper: createWrapper() },
    )
    const folder = await waitForElement(() => screen.queryByRole('button', { name: 'Research' }))
    expect(folder).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'New chat in Research' })).not.toBeInTheDocument()

    if (menu === 'overflow') {
      fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'Enter' })
    } else {
      fireEvent.contextMenu(folder)
    }
    const newChat = await waitForElement(() =>
      screen.queryByRole(isMobile ? 'button' : 'menuitem', { name: 'New chat' }),
    )
    expect(folder).toHaveAttribute('aria-expanded', 'false')

    await act(async () => {
      fireEvent.click(newChat)
    })

    expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent(`/chats/new?projectId=${project.id}`)
    expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()
    expect(folder).toHaveAttribute('aria-expanded', 'true')
  },
)

it('preserves the visible project rows and open folders while dragging a recent chat', async () => {
  for (const index of Array.from({ length: 12 }, (_, index) => index + 1)) {
    await createProject(getDb(), { name: `Project ${index}` })
  }

  const { container, rerender } = render(tree(false), { wrapper: createWrapper() })
  await waitForElement(() => screen.queryByRole('button', { name: 'Show more projects' }))
  const projectRows = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-controls^="project-chats-"]'),
  ]
  const firstProject = projectRows()[0]
  fireEvent.click(firstProject)
  expect(firstProject).toHaveAttribute('aria-expanded', 'true')

  for (const visibleCount of [5, 10]) {
    const visibleRows = projectRows()
    expect(visibleRows).toHaveLength(visibleCount)
    for (const isDragging of [true, false]) {
      rerender(tree(isDragging))
      expect(projectRows().map((row) => row.getAttribute('aria-controls'))).toEqual(
        visibleRows.map((row) => row.getAttribute('aria-controls')),
      )
      expect(firstProject).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('button', { name: 'Show more projects' })).toBeInTheDocument()
    }
    if (visibleCount === 5) {
      fireEvent.click(screen.getByRole('button', { name: 'Show more projects' }))
    }
  }

  const section = screen.getByRole('button', { name: 'Projects' })
  fireEvent.click(section)
  expect(section).toHaveAttribute('aria-expanded', 'false')
  expect(firstProject).not.toBeVisible()
  expect(screen.queryByRole('button', { name: 'Show more projects' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'New project' })).toBeVisible()

  rerender(tree(true))
  expect(section).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(section)
  expect(projectRows()).toHaveLength(10)
  expect(firstProject).toBeVisible()
  expect(firstProject).toHaveAttribute('aria-expanded', 'true')
})

it('groups collapsed projects in a menu with incremental lists and working chat submenus', async () => {
  for (const index of Array.from({ length: 12 }, (_, index) => index + 1)) {
    await createProject(getDb(), { name: `Folder ${index}` })
  }
  const project = await createProject(getDb(), { name: 'Research', icon: '🔎' })
  const onChatClick = mock(() => {})
  render(
    tree(false, false, {
      isCollapsed: true,
      onChatClick,
      chatThreads: [
        { id: 'research-chat', title: 'Interview notes', projectId: project.id, miniAppId: null, isEncrypted: 0 },
      ],
    }),
    { wrapper: createWrapper() },
  )

  const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Projects' }))
  expect(screen.queryByText('Research')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'New project' })).toBeNull()
  fireEvent.keyDown(trigger, { key: 'Enter' })
  await waitForElement(() => screen.queryByRole('menuitem', { name: 'Research' }))
  const folders = () => screen.getAllByRole('menuitem').filter((item) => item.getAttribute('aria-haspopup') === 'menu')
  expect(folders()).toHaveLength(5)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show more' }))
  expect(folders()).toHaveLength(10)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')

  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Research' }), { key: 'ArrowRight' })
  const chat = await waitForElement(() => screen.queryByRole('menuitem', { name: 'Interview notes' }))
  expect(screen.getByRole('menuitem', { name: 'New chat' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: 'Artifacts' })).toBeVisible()
  fireEvent.click(chat)
  expect(onChatClick).toHaveBeenCalledWith('research-chat', null)
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Interview notes')).not.toBeInTheDocument()
})

it('keeps management actions and dialog focus in the collapsed project submenu', async () => {
  const project = await createProject(getDb(), { name: 'Manage me' })
  render(tree(false, false, { isCollapsed: true }), { wrapper: createWrapper() })
  const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Projects' }))
  const openMenu = async () => {
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyDown(await waitForElement(() => screen.queryByRole('menuitem', { name: 'Manage me' })), {
      key: 'ArrowRight',
    })
    await waitForElement(() => screen.queryByRole('menuitem', { name: 'Edit' }))
  }
  await openMenu()
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin project' }))
  })
  expect((await getProject(getDb(), project.id))?.pinnedOrder).toBe(0)
  await openMenu()
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeVisible()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
  const dialog = await waitForElement(() => screen.queryByRole('dialog', { name: 'Project settings' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(dialog).toContainElement(document.activeElement as HTMLElement)
})

it('opens project creation from the collapsed menu without losing dialog focus', async () => {
  render(tree(false, false, { isCollapsed: true }), { wrapper: createWrapper() })
  const trigger = await waitForElement(() => screen.queryByRole('button', { name: 'Projects' }))
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(await waitForElement(() => screen.queryByRole('menuitem', { name: 'New project' })))
  const dialog = await waitForElement(() => screen.queryByRole('dialog', { name: 'Create project' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  expect(dialog).toContainElement(document.activeElement as HTMLElement)
})

it('opens project creation by long-pressing the mobile Projects heading without toggling it', async () => {
  forceMobileViewport()
  render(tree(false, true), { wrapper: createWrapper() })
  const section = await waitForElement(() => screen.queryByRole('button', { name: 'Projects' }))
  fireEvent.click(section)
  expect(section).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('button', { name: 'New project' })).toBeVisible()

  fireEvent.touchStart(section, { touches: [{ clientX: 20, clientY: 20 }] })
  act(() => getClock().tick(500))
  fireEvent.touchEnd(section)
  fireEvent.click(section)
  expect(section).toHaveAttribute('aria-expanded', 'false')

  fireEvent.click(await waitForElement(() => screen.queryByRole('button', { name: 'New project' })))
  const dialog = await waitForElement(() => screen.queryByRole('dialog', { name: 'Create project' }))
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(dialog).toContainElement(document.activeElement as HTMLElement)
  expect(section).toHaveAttribute('aria-expanded', 'false')
})

it.each(['context', 'overflow', 'mobile'])('offers the same working project actions from the %s menu', async (menu) => {
  const isMobile = menu === 'mobile'
  if (isMobile) {
    forceMobileViewport()
  }
  const project = await createProject(getDb(), { name: 'Research' })
  render(
    <>
      {tree(false, isMobile)}
      <LocationProbe />
    </>,
    { wrapper: createWrapper() },
  )
  const folder = await waitForElement(() => screen.queryByRole('button', { name: 'Research' }))
  if (isMobile) {
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
  }
  const actionRole = isMobile ? 'button' : 'menuitem'
  const openMenu = async () => {
    if (menu === 'context' || isMobile) {
      fireEvent.contextMenu(folder)
    } else {
      fireEvent.keyDown(screen.getByRole('button', { name: 'More' }), { key: 'Enter' })
    }
    await waitForElement(() => screen.queryByRole(actionRole, { name: 'Artifacts' }))
  }

  await openMenu()
  for (const name of ['New chat', 'Artifacts', 'Pin project', 'Edit', 'Delete']) {
    expect(screen.getByRole(actionRole, { name })).toBeVisible()
  }
  if (isMobile) {
    expect(screen.getByText('Research', { selector: '[data-slot="drawer-title"]' })).toBeVisible()
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull()
  } else {
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'New chat',
      'Artifacts',
      'Pin project',
      'Edit',
      'Delete',
    ])
  }
  expect(folder).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(screen.getByRole(actionRole, { name: 'Edit' }))
  const editor = await waitForElement(() => screen.queryByRole('dialog', { name: 'Project settings' }))
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Research')
  expect(editor).toContainElement(document.activeElement as HTMLElement)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  await openMenu()
  fireEvent.click(screen.getByRole(actionRole, { name: 'Delete' }))
  expect(await waitForElement(() => screen.queryByRole('alertdialog', { name: 'Delete this project?' }))).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(folder).toBeVisible()

  await openMenu()
  await act(async () => {
    fireEvent.click(screen.getByRole(actionRole, { name: 'Artifacts' }))
  })
  expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent(`/chats/new?artifacts=${project.id}`)
})

it('opens mobile project actions on long press without toggling the folder, and cancels while scrolling', async () => {
  forceMobileViewport()
  await createProject(getDb(), { name: 'Research' })
  render(tree(false, true), { wrapper: createWrapper() })
  const folder = await waitForElement(() => screen.queryByRole('button', { name: 'Research' }))

  fireEvent.touchStart(folder, { touches: [{ clientX: 20, clientY: 20 }] })
  fireEvent.touchMove(folder, { touches: [{ clientX: 20, clientY: 50 }] })
  await act(async () => {
    await getClock().tickAsync(600)
  })
  fireEvent.touchEnd(folder)
  expect(screen.queryByText('Research', { selector: '[data-slot="drawer-title"]' })).toBeNull()

  fireEvent.touchStart(folder, { touches: [{ clientX: 20, clientY: 20 }] })
  await act(async () => {
    await getClock().tickAsync(600)
  })
  fireEvent.touchEnd(folder)
  fireEvent.click(folder)
  expect(folder).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('Research', { selector: '[data-slot="drawer-title"]' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  expect(await waitForElement(() => screen.queryByRole('textbox', { name: 'Name' }))).toHaveValue('Research')
})
