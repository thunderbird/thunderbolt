/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

import { CreateItemProvider } from '@/components/create-item/context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { defaultSkillWeather } from '@/defaults/skills'
import { CreateRequestProbe } from '@/test-utils/create-request-probe'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
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

const renderBar = (props: Partial<Parameters<typeof ChatSkillsBar>[0]> = {}, showCreateProbe = false) => {
  return render(
    <MemoryRouter>
      <CreateItemProvider>
        <TooltipProvider>
          <ChatSkillsBar
            onAddToChat={props.onAddToChat ?? (() => undefined)}
            onAddInstruction={props.onAddInstruction ?? (() => undefined)}
            usePinnedSkills={props.usePinnedSkills ?? fakeUsePinnedSkills({ pinned: [] })}
            useLibrarySkills={props.useLibrarySkills ?? fakeUseLibrarySkills([])}
            useEnabledSkills={props.useEnabledSkills ?? fakeUseEnabledSkills(new Set())}
          />
          {showCreateProbe && <CreateRequestProbe />}
        </TooltipProvider>
      </CreateItemProvider>
    </MemoryRouter>,
  )
}

describe('ChatSkillsBar', () => {
  afterEach(() => {
    cleanup()
    restoreViewport()
  })

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

  it('excludes widget skills from pin candidates', () => {
    const task = { ...skill('task', 'daily-brief'), label: 'Daily Brief' }
    renderBar({
      useLibrarySkills: fakeUseLibrarySkills([task, defaultSkillWeather]),
      useEnabledSkills: fakeUseEnabledSkills(new Set([task.id, defaultSkillWeather.id])),
    })

    fireEvent.click(screen.getByLabelText('Add a skill'))

    expect(screen.getByText('Daily Brief')).toBeTruthy()
    expect(screen.queryByText('Weather')).toBeNull()
  })

  it('keeps pinned widget skill actions read-only', async () => {
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [defaultSkillWeather] }),
      useLibrarySkills: fakeUseLibrarySkills([defaultSkillWeather]),
      useEnabledSkills: fakeUseEnabledSkills(new Set([defaultSkillWeather.id])),
    })

    fireEvent.contextMenu(screen.getByText('Weather'))

    expect(await waitForElement(() => screen.queryByText('Add to chat'))).toBeTruthy()
    expect(screen.queryByText('Edit skill')).toBeNull()
    expect(screen.queryByText('Reorder')).toBeNull()
    expect(screen.queryByText('Unpin')).toBeNull()
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
    expect(screen.getByText('New Skill')).toBeTruthy()
  })

  it('opens skill creation over the current route', () => {
    const a = skill('a', 'daily-brief')
    renderBar(
      {
        usePinnedSkills: fakeUsePinnedSkills({ pinned: [a] }),
        useLibrarySkills: fakeUseLibrarySkills([a]),
        useEnabledSkills: fakeUseEnabledSkills(new Set(['a'])),
      },
      true,
    )

    const trigger = screen.getByLabelText('Add a skill')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText('New Skill'))

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('create-request')).toHaveTextContent('/|skill')
  })

  it('closes the mobile skill drawer before opening creation', () => {
    forceMobileViewport()
    const a = skill('a', 'daily-brief')
    renderBar(
      {
        usePinnedSkills: fakeUsePinnedSkills({ pinned: [a] }),
        useLibrarySkills: fakeUseLibrarySkills([a]),
        useEnabledSkills: fakeUseEnabledSkills(new Set(['a'])),
      },
      true,
    )

    const trigger = screen.getByLabelText('Add a skill')
    fireEvent.click(trigger)
    expect(document.querySelector('[data-slot="drawer-content"]')).not.toBeNull()
    fireEvent.click(screen.getByText('New Skill'))

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // The mobile card drawer must be gone before the create surface opens.
    expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull()
    expect(screen.getByTestId('create-request')).toHaveTextContent('/|skill')
  })

  it('opens the add-skill menu as a mobile bottom drawer', () => {
    forceMobileViewport()
    const a = skill('a', 'daily-brief')
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [] }),
      useLibrarySkills: fakeUseLibrarySkills([a]),
      useEnabledSkills: fakeUseEnabledSkills(new Set(['a'])),
    })

    fireEvent.click(screen.getByLabelText('Add a skill'))

    const drawer = screen
      .getByText('Add a skill', { selector: '[data-slot="drawer-title"]' })
      .closest('[data-slot="drawer-content"]')
    expect(drawer).toHaveAttribute('data-swipe-direction', 'down')
    expect(screen.getByText('Daily Brief')).toBeInTheDocument()
  })

  it('uses the normal mobile input size when the skill list is searchable', () => {
    forceMobileViewport()
    const skills = Array.from({ length: 6 }, (_, index) => skill(`skill-${index}`, `skill-${index}`))
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [] }),
      useLibrarySkills: fakeUseLibrarySkills(skills),
      useEnabledSkills: fakeUseEnabledSkills(new Set(skills.map(({ id }) => id))),
    })

    fireEvent.click(screen.getByLabelText('Add a skill'))

    expect(screen.getByRole('textbox', { name: 'Search skills' })).toHaveClass('h-[var(--touch-height-default)]')
  })

  it('keeps the New Skill action reachable when the keyboard shrinks the mobile drawer', () => {
    forceMobileViewport()
    const skills = Array.from({ length: 12 }, (_, index) => skill(`skill-${index}`, `skill-${index}`))
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [] }),
      useLibrarySkills: fakeUseLibrarySkills(skills),
      useEnabledSkills: fakeUseEnabledSkills(new Set(skills.map(({ id }) => id))),
    })

    fireEvent.click(screen.getByLabelText('Add a skill'))

    // Only the list scrolls; search and the New Skill footer stay pinned
    // inside the drawer's bounded flex column instead of clipping.
    const list = screen.getByRole('list')
    expect(list).toHaveClass('min-h-0', 'overflow-y-auto', 'overscroll-contain')
    expect(list.parentElement).toHaveClass('flex', 'min-h-0', 'flex-col')
    expect(screen.getByText('New Skill').parentElement).toHaveClass('shrink-0')
    expect(screen.getByRole('textbox', { name: 'Search skills' }).closest('.shrink-0')).toBeInTheDocument()
  })

  it('opens reorder as a mobile bottom drawer', async () => {
    forceMobileViewport()
    const a = skill('a', 'daily-brief')
    const b = skill('b', 'important-emails')
    renderBar({
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [a, b] }),
      useLibrarySkills: fakeUseLibrarySkills([a, b]),
      useEnabledSkills: fakeUseEnabledSkills(new Set(['a', 'b'])),
    })

    fireEvent.contextMenu(screen.getByText('Daily Brief'))
    fireEvent.click(await waitForElement(() => screen.queryByText('Reorder')))

    const drawer = screen
      .getByText('Reorder skills', { selector: '[data-slot="drawer-title"]' })
      .closest('[data-slot="drawer-content"]')
    expect(drawer).toHaveAttribute('data-swipe-direction', 'down')
    expect(await waitForElement(() => drawer?.querySelector('[data-base-ui-swipe-ignore]') ?? null)).toBeInTheDocument()
  })

  it('passes the full skill to preserve display-name casing', () => {
    const onAddToChat = mock<(skill: Skill) => void>(() => {})
    const a = { ...skill('a', 'hello'), label: 'Hello' }
    renderBar({
      onAddToChat,
      usePinnedSkills: fakeUsePinnedSkills({ pinned: [a] }),
      useLibrarySkills: fakeUseLibrarySkills([a]),
      useEnabledSkills: fakeUseEnabledSkills(new Set(['a'])),
    })

    fireEvent.click(screen.getByText('Hello'))
    expect(onAddToChat).toHaveBeenCalledWith(a)
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

  it('opens skill editing over the current route when choosing "Edit skill" from a chip menu', async () => {
    const a = { ...skill('a', 'daily-brief'), label: 'Daily Brief' }
    renderBar(
      {
        usePinnedSkills: fakeUsePinnedSkills({ pinned: [a] }),
        useLibrarySkills: fakeUseLibrarySkills([a]),
        useEnabledSkills: fakeUseEnabledSkills(new Set(['a'])),
      },
      true,
    )

    fireEvent.contextMenu(screen.getByText('Daily Brief'))
    fireEvent.click(await waitForElement(() => screen.queryByText('Edit skill')))

    expect(screen.getByTestId('create-request')).toHaveTextContent('/|skill')
    expect(screen.getByTestId('create-request')).toHaveAttribute('data-skill-id', 'a')
  })

  // The chip's click → onAddToChat path is exercised end-to-end at the
  // composer level; here we trust Radix's primitives.
})
