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
        label: 'Meeting Notes',
        description: 'desc',
        instruction: 'do stuff',
      })
      await setSkillPinned(getDb(), skill.id, 0)

      const { triggerChange } = renderWithReactivity(<SkillsView />, {
        tables: ['skills'],
        wrapper: Wrapper,
      })

      const switchEl = await waitForElement(() => screen.queryByRole('switch', { name: /Disable Meeting Notes/ }))
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
        label: 'Weekly Review',
        description: 'desc',
        instruction: 'plan',
      })
      // Start disabled, not pinned.
      await getDb().update(skillsTable).set({ enabled: 0 }).where(eq(skillsTable.id, skill.id))

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const switchEl = await waitForElement(() => screen.queryByRole('switch', { name: /Enable Weekly Review/ }))
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
      await createSkill(getDb(), { name: 'a', label: 'Skill A', description: 'desc a', instruction: 'standalone' })
      await createSkill(getDb(), { name: 'b', label: 'Skill B', description: 'desc b', instruction: 'then run /a' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const switchA = await waitForElement(() => screen.queryByRole('switch', { name: /Disable Skill A/ }))
      fireEvent.click(switchA)
      await flush()

      // Scope dialog assertions to the dialog itself — "Skill B" also appears
      // in the list row underneath, which makes a bare getByText ambiguous.
      // Both the title and dependent rows use display names only.
      const dialog = await waitForElement(() => screen.queryByRole('alertdialog'))
      expect(within(dialog).getByText('Disable Skill A?')).toBeInTheDocument()
      expect(within(dialog).getByText('Skill B')).toBeInTheDocument()
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()

      // /a is still enabled — the user hasn't confirmed.
      const aRecord = await getSkillByName(getDb(), 'a')
      expect(aRecord?.enabled).toBe(1)
    })
  })

  describe('form validation', () => {
    it('shows the spec violation inline as the user edits the slug directly', async () => {
      // Seed a skill so we're not in the empty-state branch when opening Create.
      await createSkill(getDb(), { name: 'seed', label: 'Seed', description: 'desc', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const createBtn = await waitForElement(() => screen.queryByRole('button', { name: 'Create skill' }))
      fireEvent.click(createBtn)
      await flush()

      // Typing in Name auto-slugifies (never invalid), so the spec error can
      // only come from a manual Slug edit.
      const slugInput = screen.getByRole('textbox', { name: 'Slug' }) as HTMLInputElement
      fireEvent.change(slugInput, { target: { value: 'Has-Caps' } })
      await flush()

      expect(screen.getByText(/lowercase letters, numbers, and hyphens/i)).toBeInTheDocument()
      const submitBtn = screen.getByRole('button', { name: 'Create' })
      expect(submitBtn).toBeDisabled()
    })

    it('auto-generates the slug from the Name until the slug is edited', async () => {
      await createSkill(getDb(), { name: 'seed', label: 'Seed', description: 'desc', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const createBtn = await waitForElement(() => screen.queryByRole('button', { name: 'Create skill' }))
      fireEvent.click(createBtn)
      await flush()

      const nameInput = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
      const slugInput = screen.getByRole('textbox', { name: 'Slug' }) as HTMLInputElement

      fireEvent.change(nameInput, { target: { value: 'Meeting Notes!' } })
      await flush()
      expect(slugInput.value).toBe('meeting-notes')

      // Manual slug edit detaches auto-generation.
      fireEvent.change(slugInput, { target: { value: 'custom-slug' } })
      fireEvent.change(nameInput, { target: { value: 'Renamed Again' } })
      await flush()
      expect(slugInput.value).toBe('custom-slug')
    })

    it('opens a blank create form for the empty-string deep link', async () => {
      // The chat skills bar's "New skill" row navigates with
      // `createSkill: ''` — a valid deep link that must open the form blank
      // rather than being treated as "no link".
      await createSkill(getDb(), { name: 'seed', label: 'Seed', description: 'desc', instruction: 'i' })

      renderWithReactivity(<SkillsView />, {
        tables: ['skills'],
        wrapper: wrapperWithNavState({ createSkill: '' }),
      })

      const nameInput = await waitForElement(() => screen.queryByRole('textbox', { name: 'Name' }))
      expect((nameInput as HTMLInputElement).value).toBe('')
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
    })

    it('pre-fills the create form when the deep link carries a slug', async () => {
      await createSkill(getDb(), { name: 'seed', label: 'Seed', description: 'desc', instruction: 'i' })

      renderWithReactivity(<SkillsView />, {
        tables: ['skills'],
        wrapper: wrapperWithNavState({ createSkill: 'meeting-notes' }),
      })

      // Slug carries the typed token verbatim; Name gets a Title Case
      // suggestion derived from it.
      const slugInput = await waitForElement(() => screen.queryByRole('textbox', { name: 'Slug' }))
      expect((slugInput as HTMLInputElement).value).toBe('meeting-notes')
      const nameInput = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
      expect(nameInput.value).toBe('Meeting Notes')
    })

    it('opens the edit form directly for the startEditSkill deep link', async () => {
      // The chat skills bar's chip menu "Edit skill" navigates with
      // `startEditSkill: <id>` — lands in the edit form, not the detail view.
      const created = await createSkill(getDb(), {
        name: 'daily-brief',
        label: 'Daily Brief',
        description: 'desc',
        instruction: 'do stuff',
      })

      renderWithReactivity(<SkillsView />, {
        tables: ['skills'],
        wrapper: wrapperWithNavState({ startEditSkill: created.id }),
      })

      await waitForElement(() => screen.queryByText('Edit skill'))
      const nameInput = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
      expect(nameInput.value).toBe('Daily Brief')
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    })

    it('surfaces SkillNameTakenError inline when submitting a duplicate name', async () => {
      await createSkill(getDb(), { name: 'meeting-notes', label: 'Meeting Notes', description: 'd', instruction: 'i' })
      await createSkill(getDb(), { name: 'other', label: 'Other', description: 'd', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })

      const createBtn = await waitForElement(() => screen.queryByRole('button', { name: 'Create skill' }))
      fireEvent.click(createBtn)
      await flush()

      // Typing the colliding name auto-generates the colliding slug.
      const nameInput = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: 'Meeting Notes' } })
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
      await createSkill(getDb(), { name: 'alpha', label: 'Alpha', description: 'd', instruction: 'do alpha things' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })
      await waitForElement(() => screen.queryByText('Alpha'))

      // The detail surface (with its close affordance) must not auto-open.
      expect(screen.queryByRole('button', { name: 'Close details' })).not.toBeInTheDocument()
      expect(screen.queryByText('do alpha things')).not.toBeInTheDocument()

      fireEvent.click(screen.getByText('Alpha'))
      await flush()

      expect(screen.getByText('do alpha things')).toBeInTheDocument()
    })
  })

  describe('dirty form guard', () => {
    const openCreateFormAndDirty = async () => {
      const createBtn = await waitForElement(() => screen.queryByRole('button', { name: 'Create skill' }))
      fireEvent.click(createBtn)
      await flush()
      const nameInput = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: 'Draft' } })
      await flush()
    }

    const editSkillFromRowContextMenu = async (label: string) => {
      fireEvent.contextMenu(screen.getByText(label))
      await flush()
      fireEvent.click(await waitForElement(() => screen.queryByText('Edit')))
      await flush()
    }

    it('editing another skill from a dirty create form routes through the discard dialog', async () => {
      await createSkill(getDb(), { name: 'alpha', label: 'Alpha', description: 'd', instruction: 'i' })
      await createSkill(getDb(), { name: 'beta', label: 'Beta', description: 'd', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })
      await waitForElement(() => screen.queryByText('Beta'))

      await openCreateFormAndDirty()
      await editSkillFromRowContextMenu('Beta')

      // Guarded: the dialog appears instead of the click silently dying.
      expect(screen.getByText('Leave without creating?')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      await flush()

      // Confirming lands in a fresh edit form on the target skill.
      const editName = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
      expect(editName.value).toBe('Beta')
      const editSlug = screen.getByRole('textbox', { name: 'Slug' }) as HTMLInputElement
      expect(editSlug.value).toBe('beta')
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    })

    it('"Keep editing" preserves the dirty form', async () => {
      await createSkill(getDb(), { name: 'alpha', label: 'Alpha', description: 'd', instruction: 'i' })
      await createSkill(getDb(), { name: 'beta', label: 'Beta', description: 'd', instruction: 'i' })

      renderWithReactivity(<SkillsView />, { tables: ['skills'], wrapper: Wrapper })
      await waitForElement(() => screen.queryByText('Beta'))

      await openCreateFormAndDirty()
      await editSkillFromRowContextMenu('Beta')

      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
      await flush()

      const nameInput = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
      expect(nameInput.value).toBe('Draft')
    })
  })
})
