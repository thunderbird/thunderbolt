/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { domMax, LazyMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

import { SidebarProvider } from '@/components/ui/sidebar'
import { createSkill, getSkill, getSkillByName, setSkillPinned } from '@/dal'
// Import for side effect: registers the framer-motion `mock.module` so the
// `m.li layoutId` rows from `library-row.tsx` render to plain `<li>` and the
// `LazyMotion` wrapper below is the no-op passthrough.
import '@/test-utils/framer-motion-mock'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { skillsTable } from '@/db/tables'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { SkillsView } from './skills-view'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

afterEach(() => {
  cleanup()
})

const Wrapper = ({ children }: { children: ReactNode }) => (
  <LazyMotion features={domMax}>
    <MemoryRouter>
      <SidebarProvider>{children}</SidebarProvider>
    </MemoryRouter>
  </LazyMotion>
)

/** Wrapper that mounts the route with router state, for deep-link tests. */
const wrapperWithNavState = (state: Record<string, unknown>) => {
  const WrapperWithState = ({ children }: { children: ReactNode }) => (
    <LazyMotion features={domMax}>
      <MemoryRouter initialEntries={[{ pathname: '/settings/skills', state }]}>
        <SidebarProvider>{children}</SidebarProvider>
      </MemoryRouter>
    </LazyMotion>
  )
  return WrapperWithState
}

// Flush pending mutation work + React's effect queue so the next assertion
// sees the post-write state. The global fake clock means microtasks scheduled
// by useMutation / setState don't run on their own.
const flush = async () => {
  await act(async () => {
    await getClock().runAllAsync()
  })
}

describe('SkillsView state machine', () => {
  describe('handleToggleEnabled — auto-unpin on disable', () => {
    it('unpins a pinned skill when its row switch is turned off', async () => {
      const skill = await createSkill(getDb(), {
        name: 'meeting-notes',
        description: 'desc',
        instruction: 'do stuff',
      })
      await setSkillPinned(getDb(), skill.id, 0)

      const { triggerChange } = renderWithReactivity(<SkillsView />, {
        tables: ['skills'],
        wrapper: Wrapper,
      })

      const switchEl = await waitForElement(() => screen.queryByRole('switch', { name: /Disable \/meeting-notes/ }))
      fireEvent.click(switchEl)
      await flush()
      triggerChange(['skills'])
      await flush()

      const after = await getSkill(getDb(), skill.id)
      expect(after?.enabled).toBe(0)
      expect(after?.pinnedOrder).toBeNull()
    })

    it('does not auto-repin when toggling enabled back on', async () => {
      const skill = await createSkill(getDb(), {
        name: 'weekly-review',
        description: 'desc',
        instruction: 'plan',
      })
      // Start disabled, not pinned.
      await getDb().update(skillsTable).set({ enabled: 0 }).where(eq(skillsTable.id, skill.id))

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const switchEl = await waitForElement(() => screen.queryByRole('switch', { name: /Enable \/weekly-review/ }))
      fireEvent.click(switchEl)
      await flush()

      const after = await getSkill(getDb(), skill.id)
      expect(after?.enabled).toBe(1)
      expect(after?.pinnedOrder).toBeNull()
    })
  })

  describe('dependents dialog dispatch', () => {
    it('blocks a direct disable when other skills reference the target', async () => {
      // /a is referenced by /b. Disabling /a should open the dependents-aware
      // confirm dialog instead of immediately setting enabled=0.
      await createSkill(getDb(), { name: 'a', description: 'desc a', instruction: 'standalone' })
      await createSkill(getDb(), { name: 'b', description: 'desc b', instruction: 'then run /a' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const switchA = await waitForElement(() => screen.queryByRole('switch', { name: /Disable \/a/ }))
      fireEvent.click(switchA)
      await flush()

      // Scope dialog assertions to the dialog itself — `/b` also appears in
      // the list row underneath, which makes a bare `getByText('/b')`
      // ambiguous.
      const dialog = await waitForElement(() => screen.queryByRole('alertdialog'))
      expect(within(dialog).getByText('Disable /a?')).toBeInTheDocument()
      expect(within(dialog).getByText('/b')).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()

      // /a is still enabled — the user hasn't confirmed.
      const aRecord = await getSkillByName(getDb(), 'a')
      expect(aRecord?.enabled).toBe(1)
    })
  })

  describe('form validation', () => {
    it('shows the spec violation inline as the user types', async () => {
      // Seed a skill so we're not in the empty-state branch when opening Create.
      await createSkill(getDb(), { name: 'seed', description: 'desc', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const createBtn = await waitForElement(() => screen.queryByRole('button', { name: 'Create skill' }))
      fireEvent.click(createBtn)
      await flush()

      const nameInput = screen.getByRole('textbox', { name: /Skill name/ }) as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: 'Has-Caps' } })
      await flush()

      expect(screen.getByText(/lowercase letters, numbers, and hyphens/i)).toBeInTheDocument()
      const submitBtn = screen.getByRole('button', { name: 'Create' })
      expect(submitBtn).toBeDisabled()
    })

    it('opens a blank create form for the empty-string deep link', async () => {
      // The chat skills bar's "New skill" row navigates with
      // `createSkill: ''` — a valid deep link that must open the form blank
      // rather than being treated as "no link".
      await createSkill(getDb(), { name: 'seed', description: 'desc', instruction: 'i' })

      renderWithReactivity(<SkillsView />, {
        tables: ['skills'],
        wrapper: wrapperWithNavState({ createSkill: '' }),
      })

      const nameInput = await waitForElement(() => screen.queryByRole('textbox', { name: /Skill name/ }))
      expect((nameInput as HTMLInputElement).value).toBe('')
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
    })

    it('pre-fills the create form when the deep link carries a slug', async () => {
      await createSkill(getDb(), { name: 'seed', description: 'desc', instruction: 'i' })

      renderWithReactivity(<SkillsView />, {
        tables: ['skills'],
        wrapper: wrapperWithNavState({ createSkill: 'meeting-notes' }),
      })

      const nameInput = await waitForElement(() => screen.queryByRole('textbox', { name: /Skill name/ }))
      expect((nameInput as HTMLInputElement).value).toBe('meeting-notes')
    })

    it('surfaces SkillNameTakenError inline when submitting a duplicate name', async () => {
      await createSkill(getDb(), { name: 'meeting-notes', description: 'd', instruction: 'i' })
      await createSkill(getDb(), { name: 'other', description: 'd', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const createBtn = await waitForElement(() => screen.queryByRole('button', { name: 'Create skill' }))
      fireEvent.click(createBtn)
      await flush()

      const nameInput = screen.getByRole('textbox', { name: /Skill name/ }) as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: 'meeting-notes' } })
      const descInput = screen.getByRole('textbox', { name: /Description/ }) as HTMLTextAreaElement
      fireEvent.change(descInput, { target: { value: 'collision test' } })
      const instInput = screen.getByRole('textbox', { name: /Instructions/ }) as HTMLTextAreaElement
      fireEvent.change(instInput, { target: { value: 'do thing' } })
      await flush()

      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      await flush()

      const errorText = await waitForElement(() => screen.queryByText(/already exists/i))
      expect(errorText).toBeTruthy()
    })
  })

  describe('panel visibility', () => {
    it('shows no detail panel until a skill is explicitly selected (no first-skill fallback)', async () => {
      await createSkill(getDb(), { name: 'alpha', description: 'd', instruction: 'do alpha things' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })
      await waitForElement(() => screen.queryByText('/alpha'))

      // The detail surface (with its close affordance) must not auto-open.
      expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()
      expect(screen.queryByText('do alpha things')).not.toBeInTheDocument()

      fireEvent.click(screen.getByText('/alpha'))
      await flush()

      expect(screen.getByText('do alpha things')).toBeInTheDocument()
    })
  })

  describe('dirty form guard', () => {
    const openCreateFormAndDirty = async () => {
      const createBtn = await waitForElement(() => screen.queryByRole('button', { name: 'Create skill' }))
      fireEvent.click(createBtn)
      await flush()
      const nameInput = screen.getByRole('textbox', { name: /Skill name/ }) as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: 'draft' } })
      await flush()
    }

    const editSkillFromRowContextMenu = async (name: string) => {
      fireEvent.contextMenu(screen.getByText(`/${name}`))
      await flush()
      fireEvent.click(await waitForElement(() => screen.queryByText('Edit')))
      await flush()
    }

    it('editing another skill from a dirty create form routes through the discard dialog', async () => {
      await createSkill(getDb(), { name: 'alpha', description: 'd', instruction: 'i' })
      await createSkill(getDb(), { name: 'beta', description: 'd', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })
      await waitForElement(() => screen.queryByText('/beta'))

      await openCreateFormAndDirty()
      await editSkillFromRowContextMenu('beta')

      // Guarded: the dialog appears instead of the click silently dying.
      expect(screen.getByText('Leave without creating?')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      await flush()

      // Confirming lands in a fresh edit form on the target skill.
      const editName = screen.getByRole('textbox', { name: /Skill name/ }) as HTMLInputElement
      expect(editName.value).toBe('beta')
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    })

    it('"Keep editing" preserves the dirty form', async () => {
      await createSkill(getDb(), { name: 'alpha', description: 'd', instruction: 'i' })
      await createSkill(getDb(), { name: 'beta', description: 'd', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })
      await waitForElement(() => screen.queryByText('/beta'))

      await openCreateFormAndDirty()
      await editSkillFromRowContextMenu('beta')

      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
      await flush()

      const nameInput = screen.getByRole('textbox', { name: /Skill name/ }) as HTMLInputElement
      expect(nameInput.value).toBe('draft')
    })
  })
})
