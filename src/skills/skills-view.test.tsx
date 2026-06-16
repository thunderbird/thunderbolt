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
import { seedTestPersonalAdminMembership, wsId } from '@/dal/test-utils'
// Import for side effect: registers the framer-motion `mock.module` so the
// `m.li layoutId` rows from `library-row.tsx` render to plain `<li>` and the
// `LazyMotion` wrapper below is the no-op passthrough.
import '@/test-utils/framer-motion-mock'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { skillsTable } from '@/db/tables'
import {
  renderWithReactivity,
  waitForElement,
  resetTestTrustDomain,
  seedTestTrustDomain,
} from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { SkillsView } from './skills-view'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  seedTestTrustDomain()
  await resetTestDatabase()
  // SkillsView uses `useWorkspacePermission('add_skills' / 'remove_skills')`
  // to gate the Create + Delete affordances. Seed the personal-admin
  // membership so the test user resolves as admin and the buttons render.
  await seedTestPersonalAdminMembership()
})

afterEach(() => {
  resetTestTrustDomain()
  cleanup()
})

const Wrapper = ({ children }: { children: ReactNode }) => (
  <LazyMotion features={domMax}>
    <MemoryRouter>
      <SidebarProvider>{children}</SidebarProvider>
    </MemoryRouter>
  </LazyMotion>
)

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
      const skill = await createSkill(getDb(), wsId, {
        name: 'meeting-notes',
        description: 'desc',
        instruction: 'do stuff',
      })
      await setSkillPinned(getDb(), wsId, skill.id, 0)

      const { triggerChange } = renderWithReactivity(<SkillsView />, {
        tables: ['skills'],
        wrapper: Wrapper,
      })

      const switchEl = await waitForElement(() => screen.queryByRole('switch', { name: /Disable \/meeting-notes/ }))
      fireEvent.click(switchEl)
      await flush()
      triggerChange(['skills'])
      await flush()

      const after = await getSkill(getDb(), wsId, skill.id)
      expect(after?.enabled).toBe(0)
      expect(after?.pinnedOrder).toBeNull()
    })

    it('does not auto-repin when toggling enabled back on', async () => {
      const skill = await createSkill(getDb(), wsId, {
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

      const after = await getSkill(getDb(), wsId, skill.id)
      expect(after?.enabled).toBe(1)
      expect(after?.pinnedOrder).toBeNull()
    })
  })

  describe('dependents dialog dispatch', () => {
    it('blocks a direct disable when other skills reference the target', async () => {
      // /a is referenced by /b. Disabling /a should open the dependents-aware
      // confirm dialog instead of immediately setting enabled=0.
      await createSkill(getDb(), wsId, { name: 'a', description: 'desc a', instruction: 'standalone' })
      await createSkill(getDb(), wsId, { name: 'b', description: 'desc b', instruction: 'then run /a' })

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
      const aRecord = await getSkillByName(getDb(), wsId, 'a')
      expect(aRecord?.enabled).toBe(1)
    })
  })

  describe('form validation', () => {
    it('shows the spec violation inline as the user types', async () => {
      // Seed a skill so we're not in the empty-state branch when opening Create.
      await createSkill(getDb(), wsId, { name: 'seed', description: 'desc', instruction: 'i' })

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

    it('surfaces SkillNameTakenError inline when submitting a duplicate name', async () => {
      await createSkill(getDb(), wsId, { name: 'meeting-notes', description: 'd', instruction: 'i' })
      await createSkill(getDb(), wsId, { name: 'other', description: 'd', instruction: 'i' })

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
})
