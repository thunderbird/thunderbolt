/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
// Import for side effect: framer-motion mock so the row `m.li` renders to a
// plain `<li>` in jsdom.
import '@/test-utils/framer-motion-mock'
import { SkillsList } from './skills-list'
import type { Skill } from '@/types'

afterEach(cleanup)

const skill: Skill = {
  id: 's1',
  name: 'meeting-notes',
  description: 'desc',
  instruction: 'do',
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  workspaceId: null,
}

const renderList = (props: { canCreate?: boolean } = {}) => {
  render(
    <MemoryRouter>
      <SidebarProvider>
        <SkillsList
          skills={[skill]}
          activeSkillId={null}
          isEnabled={() => true}
          canCreate={props.canCreate}
          onToggleEnabled={mock(() => {})}
          onCreate={mock(() => {})}
          onSelectSkill={mock(() => {})}
          onEdit={mock(() => {})}
          onDelete={mock(() => {})}
        />
      </SidebarProvider>
    </MemoryRouter>,
  )
}

describe('SkillsList — permission gating', () => {
  it('hides the Create button when canCreate is false', () => {
    renderList({ canCreate: false })

    expect(screen.queryByRole('button', { name: 'Create skill' })).not.toBeInTheDocument()
  })

  it('shows the Create button by default', () => {
    renderList()

    expect(screen.getByRole('button', { name: 'Create skill' })).toBeInTheDocument()
  })
})
