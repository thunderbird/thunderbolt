/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defaultSkillMap, defaultSkillWeather } from '@/defaults/skills'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { nextPinnedOrder, useStickySkills } from './use-skills'

describe('nextPinnedOrder', () => {
  it('starts at zero with no pins', () => {
    expect(nextPinnedOrder([])).toBe(0)
  })

  it('lands after the last pin when positions have a gap', () => {
    expect(nextPinnedOrder([{ pinnedOrder: 0 }, { pinnedOrder: 2 }])).toBe(3)
  })
})

describe('useStickySkills', () => {
  it('keeps a shown row listed after it becomes hidden', () => {
    const all = [defaultSkillMap, defaultSkillWeather]
    const hook = renderHook(({ visible }) => useStickySkills(visible, all), {
      initialProps: { visible: all },
    })

    hook.rerender({ visible: [defaultSkillWeather] })

    expect(hook.result.current).toEqual(all)
  })

  it('leaves out a row that was never shown', () => {
    const hook = renderHook(() => useStickySkills([defaultSkillWeather], [defaultSkillMap, defaultSkillWeather]))
    expect(hook.result.current).toEqual([defaultSkillWeather])
  })

  it('drops a shown row once it is deleted', () => {
    const hook = renderHook(({ all }) => useStickySkills([defaultSkillWeather], all), {
      initialProps: { all: [defaultSkillWeather] },
    })

    hook.rerender({ all: [] })

    expect(hook.result.current).toEqual([])
  })
})
