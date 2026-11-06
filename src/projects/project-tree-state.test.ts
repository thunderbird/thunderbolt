/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { projectTreeReducer } from './project-tree-state'

describe('project tree navigation', () => {
  it('reveals the destination project without closing another expanded project', () => {
    const state = { activeId: 'a', expanded: new Set(['a']) }
    const next = projectTreeReducer(state, { type: 'navigate', id: 'b' })
    expect([...next.expanded]).toEqual(['a', 'b'])
    expect(next.activeId).toBe('b')
    expect([...state.expanded]).toEqual(['a'])
  })

  it('lets the active project collapse, then reveals it when returning from another route', () => {
    const collapsed = projectTreeReducer({ activeId: 'a', expanded: new Set(['a']) }, { type: 'toggle', id: 'a' })
    expect(collapsed.expanded.has('a')).toBe(false)
    const away = projectTreeReducer(collapsed, { type: 'navigate', id: null })
    const returned = projectTreeReducer(away, { type: 'navigate', id: 'a' })
    expect(returned.expanded.has('a')).toBe(true)
  })

  it('keeps open folders when starting an ordinary chat', () => {
    const next = projectTreeReducer({ activeId: 'a', expanded: new Set(['a', 'b']) }, { type: 'navigate', id: null })
    expect(next.activeId).toBeNull()
    expect([...next.expanded]).toEqual(['a', 'b'])
  })
})
