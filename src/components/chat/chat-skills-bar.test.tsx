/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Skill } from '@/types'
import { ChatSkillsBar } from './chat-skills-bar'

const skill = (id: string, name: string): Skill => ({
  id,
  name,
  description: `desc for ${name}`,
  instruction: `instruction for ${name}`,
  enabled: 1,
  pinnedOrder: 0,
  deletedAt: null,
  defaultHash: null,
  userId: null,
})

const fakeUsePinnedSkills = (overrides?: {
  pinned?: Skill[]
  togglePin?: (id: string) => Promise<void>
  reorderPins?: (ids: string[]) => Promise<void>
}) =>
  (() => ({
    pinned: overrides?.pinned ?? [],
    pinnedSet: new Set((overrides?.pinned ?? []).map((s) => s.id)),
    togglePin: overrides?.togglePin ?? (async () => undefined),
    reorderPins: overrides?.reorderPins ?? (async () => undefined),
  })) as unknown as typeof import('@/skills/use-skills').usePinnedSkills

const renderBar = (props: Partial<Parameters<typeof ChatSkillsBar>[0]> & { isMobile?: boolean } = {}) => {
  const { isMobile, ...rest } = props
  if (isMobile !== undefined) {
    // Force the useIsMobile() hook to a deterministic value via matchMedia.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: isMobile,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    })
  }
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ChatSkillsBar
          onAddToChat={() => undefined}
          onAddInstruction={() => undefined}
          usePinnedSkills={rest.usePinnedSkills ?? fakeUsePinnedSkills({ pinned: [] })}
          useNavigate={rest.useNavigate ?? (() => () => undefined)}
        />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('ChatSkillsBar', () => {
  afterEach(cleanup)

  it('renders nothing when there are no pinned skills', () => {
    const { container } = renderBar()
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip per pinned skill plus the Manage shortcut', () => {
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [skill('a', 'meeting-notes'), skill('b', 'weekly-review')] }),
    })
    expect(screen.getByText('/meeting-notes')).toBeTruthy()
    expect(screen.getByText('/weekly-review')).toBeTruthy()
    expect(screen.getByLabelText('Manage skills')).toBeTruthy()
  })

  // The chip's click → onAddToChat path is exercised end-to-end in
  // chat-prompt-input.test.tsx; the Radix DropdownMenuTrigger composes its
  // own click handlers on top of ours, and reliably simulating that here
  // requires either userEvent (not in the test deps) or mocking the menu
  // primitives (a module-level mock.module leak, see testing.md §65). The
  // chat-prompt-input integration test verifies the same user-visible
  // behavior without the simulation friction.

  it('the Manage shortcut links to /settings/skills', () => {
    renderBar({ usePinnedSkills: fakeUsePinnedSkills({ pinned: [skill('a', 'meeting-notes')] }) })
    const link = screen.getByLabelText('Manage skills') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/settings/skills')
  })
})
