/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'

import { TooltipProvider } from '@/components/ui/tooltip'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import type { Skill } from '@/types'
import { ChatSkillsBar } from './chat-skills-bar'

const skill = (id: string, name: string): Skill => ({
  id,
  name,
  label: null,
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

const fakeUseLibrarySkills = (skills: Skill[] = []) =>
  (() => ({
    skills,
    isLoading: false,
    createSkill: async () => skills[0]!,
    updateSkill: async () => undefined,
    softDeleteSkill: async () => undefined,
  })) as unknown as typeof import('@/skills/use-skills').useLibrarySkills

const fakeUseEnabledSkills = (enabledIds: ReadonlySet<string>) =>
  (() => ({
    isEnabled: (id: string) => enabledIds.has(id),
    setEnabled: async () => undefined,
  })) as unknown as typeof import('@/skills/use-skills').useEnabledSkills

const renderBar = (props: Partial<Parameters<typeof ChatSkillsBar>[0]> = {}) => {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <ChatSkillsBar
          onAddToChat={() => undefined}
          onAddInstruction={() => undefined}
          usePinnedSkills={props.usePinnedSkills ?? fakeUsePinnedSkills({ pinned: [] })}
          useLibrarySkills={props.useLibrarySkills ?? fakeUseLibrarySkills([])}
          useEnabledSkills={props.useEnabledSkills ?? fakeUseEnabledSkills(new Set())}
        />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('ChatSkillsBar', () => {
  afterEach(cleanup)

  it('renders nothing when there are no pinned skills and nothing to pin', () => {
    const { container } = renderBar()
    expect(container.firstChild).toBeNull()
  })

  it('renders one chip per pinned skill plus the "Add a skill" trigger', () => {
    // Chips show the display name (label) when present; label-less legacy
    // rows fall back to a title-cased slug — no leading slash either way.
    const a = { ...skill('a', 'daily-brief'), label: 'Daily Brief' }
    const b = skill('b', 'important-emails')
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [a, b] }),
      useLibrarySkills: fakeUseLibrarySkills([a, b]),
      useEnabledSkills: fakeUseEnabledSkills(new Set(['a', 'b'])),
    })
    expect(screen.getByText('Daily Brief')).toBeTruthy()
    expect(screen.getByText('Important Emails')).toBeTruthy()
    expect(screen.getByLabelText('Add a skill')).toBeTruthy()
  })

  it('renders the "+ Add a skill" trigger even when nothing is pinned, so long as the library has pin candidates', () => {
    const a = skill('a', 'daily-brief')
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [] }),
      useLibrarySkills: fakeUseLibrarySkills([a]),
      useEnabledSkills: fakeUseEnabledSkills(new Set(['a'])),
    })
    expect(screen.getByLabelText('Add a skill')).toBeTruthy()
  })

  it('keeps the "+ Add a skill" trigger clickable when every enabled skill is already pinned (popover still offers New skill)', () => {
    const a = skill('a', 'daily-brief')
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [a] }),
      useLibrarySkills: fakeUseLibrarySkills([a]),
      useEnabledSkills: fakeUseEnabledSkills(new Set(['a'])),
    })
    const trigger = screen.getByLabelText('Add a skill') as HTMLButtonElement
    expect(trigger.disabled).toBe(false)

    fireEvent.click(trigger)
    expect(screen.getByText('All skills are pinned')).toBeTruthy()
    expect(screen.getByText('New skill')).toBeTruthy()
  })

  it('disables the "+ Add a skill" trigger when the pin cap is reached (even with unpinned candidates available)', () => {
    // 10 pinned + 1 unpinned candidate → cap reached. Without this guard the
    // popover would show the candidate but clicking would silently fail
    // because the DAL throws PinLimitExceededError on the 11th pin.
    const pinnedSkills = Array.from({ length: 10 }, (_, i) => skill(`p-${i}`, `pinned-${i}`))
    const candidate = skill('c', 'eleventh')
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: pinnedSkills }),
      useLibrarySkills: fakeUseLibrarySkills([...pinnedSkills, candidate]),
      useEnabledSkills: fakeUseEnabledSkills(new Set([...pinnedSkills.map((s) => s.id), 'c'])),
    })
    const trigger = screen.getByLabelText('Add a skill') as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
  })

  it('navigates to the skill\'s edit form when choosing "Edit skill" from a chip menu', async () => {
    const a = { ...skill('a', 'daily-brief'), label: 'Daily Brief' }
    const LocationProbe = () => {
      const location = useLocation()
      return <div data-testid="location">{`${location.pathname}|${JSON.stringify(location.state)}`}</div>
    }
    render(
      <MemoryRouter>
        <TooltipProvider>
          <ChatSkillsBar
            onAddToChat={() => undefined}
            onAddInstruction={() => undefined}
            usePinnedSkills={fakeUsePinnedSkills({ pinned: [a] })}
            useLibrarySkills={fakeUseLibrarySkills([a])}
            useEnabledSkills={fakeUseEnabledSkills(new Set(['a']))}
          />
          <LocationProbe />
        </TooltipProvider>
      </MemoryRouter>,
    )

    fireEvent.contextMenu(screen.getByText('Daily Brief'))
    fireEvent.click(await waitForElement(() => screen.queryByText('Edit skill')))

    expect(screen.getByTestId('location').textContent).toBe('/settings/skills|{"startEditSkill":"a"}')
  })

  // The chip's click → onAddToChat path is exercised end-to-end at the
  // composer level; here we trust Radix's primitives.
})
