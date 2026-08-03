/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { domMax, LazyMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

import { SidebarProvider } from '@/components/ui/sidebar'
import { createSkill, getAllSkills } from '@/dal'
// Import for side effect: rewrites framer-motion `m.li` rows to plain `<li>`.
import '@/test-utils/framer-motion-mock'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { EntityActionIntent } from '@/search/actions/types'
import { PowerSyncReactivityTestProvider } from '@/test-utils/powersync-mock'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { SkillsView } from './skills-view'

// The palette delivers the intent one-shot at mount, before a cold PowerSync
// query would resolve. In production the `['skills']` query is already warm
// (the composer subscribes to it app-wide), so `onDelete`/`onEdit` see the
// loaded list synchronously. Prewarm the React Query cache with the seeded
// rows to reproduce that ordering deterministically in the test.
const renderWithIntent = async (intent: EntityActionIntent) => {
  const skills = await getAllSkills(getDb())
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  })
  queryClient.setQueryData(['skills'], skills)

  const state = { skillsAction: JSON.stringify(intent) }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LazyMotion features={domMax}>
      <PowerSyncReactivityTestProvider tables={['skills']} queryClient={queryClient}>
        <MemoryRouter initialEntries={[{ pathname: '/settings/skills', state }]}>
          <SidebarProvider>{children}</SidebarProvider>
        </MemoryRouter>
      </PowerSyncReactivityTestProvider>
    </LazyMotion>
  )
  return render(<SkillsView />, { wrapper })
}

describe('SkillsView palette action intents', () => {
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

  it('opens the create form for a create intent', async () => {
    await renderWithIntent({ type: 'create' })

    await waitForElement(() => screen.queryByText('Create Skill'))
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('opens the edit form for an edit intent', async () => {
    const created = await createSkill(getDb(), {
      name: 'daily-brief',
      label: 'Daily Brief',
      description: 'desc',
      instruction: 'do stuff',
    })

    await renderWithIntent({ type: 'edit', id: created.id })

    await waitForElement(() => screen.queryByText('Edit Skill'))
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Daily Brief')
  })

  it('opens the delete confirmation for a remove intent on a standalone skill', async () => {
    const created = await createSkill(getDb(), {
      name: 'removable',
      label: 'Removable',
      description: 'desc',
      instruction: 'standalone',
    })

    await renderWithIntent({ type: 'remove', id: created.id })

    const dialog = await waitForElement(() => screen.queryByRole('alertdialog'))
    expect(within(dialog).getByText('Delete Removable?')).toBeInTheDocument()
  })

  it('routes a remove intent through the dependents-aware confirm when referenced', async () => {
    // /a is referenced by /b — removing /a must surface the dependents dialog,
    // proving the intent goes through onDelete rather than deleting directly.
    const a = await createSkill(getDb(), {
      name: 'a',
      label: 'Skill A',
      description: 'desc a',
      instruction: 'standalone',
    })
    await createSkill(getDb(), { name: 'b', label: 'Skill B', description: 'desc b', instruction: 'then run /a' })

    await renderWithIntent({ type: 'remove', id: a.id })

    const dialog = await waitForElement(() => screen.queryByRole('alertdialog'))
    expect(within(dialog).getByText('Delete Skill A?')).toBeInTheDocument()
    expect(within(dialog).getByText('Skill B')).toBeInTheDocument()
  })
})
