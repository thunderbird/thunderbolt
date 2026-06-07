/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { Skill } from '@/types'
import { findDependents } from './find-dependents'

const skill = (overrides: Partial<Skill> & { id: string; name: string }): Skill => ({
  description: '',
  instruction: '',
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
  workspaceId: null,
  ...overrides,
})

describe('findDependents', () => {
  it('returns empty when no other skill references the target', () => {
    const target = 'meeting-notes'
    const library = [
      skill({ id: '1', name: target }),
      skill({ id: '2', name: 'weekly-review', instruction: 'do stuff' }),
    ]
    expect(findDependents(target, library)).toEqual([])
  })

  it('finds a single dependent referencing /target in instruction', () => {
    const target = 'task-triage'
    const dependent = skill({
      id: 'd',
      name: 'weekly-review',
      instruction: 'Step 3: run /task-triage on the open items.',
    })
    const result = findDependents(target, [skill({ id: 't', name: target }), dependent])
    expect(result).toEqual([dependent])
  })

  it('finds a dependent referencing /target in description', () => {
    const target = 'meeting-notes'
    const dependent = skill({
      id: 'd',
      name: 'recap',
      description: 'Follow up on /meeting-notes output.',
    })
    const result = findDependents(target, [skill({ id: 't', name: target }), dependent])
    expect(result).toEqual([dependent])
  })

  it('returns multiple dependents when several skills reference the target', () => {
    const target = 'meeting-notes'
    const a = skill({ id: 'a', name: 'recap', instruction: 'see /meeting-notes' })
    const b = skill({ id: 'b', name: 'plan', instruction: 'after /meeting-notes runs' })
    const library = [skill({ id: 't', name: target }), a, b]
    expect(findDependents(target, library)).toEqual([a, b])
  })

  it('does not include the target itself', () => {
    const target = 'self-ref'
    // A skill referencing its own slug in its own instruction shouldn't show
    // up as its own dependent.
    const self = skill({ id: 't', name: target, instruction: 'run /self-ref again' })
    expect(findDependents(target, [self])).toEqual([])
  })

  it('matches at a word boundary — followed by whitespace or end-of-line', () => {
    const target = 'foo'
    const okSpace = skill({ id: 'a', name: 'a', instruction: 'use /foo here' })
    const okEnd = skill({ id: 'b', name: 'b', instruction: 'use /foo' })
    const okNewline = skill({ id: 'c', name: 'c', instruction: '/foo\nnext line' })
    expect(findDependents(target, [skill({ id: 't', name: target }), okSpace, okEnd, okNewline])).toEqual([
      okSpace,
      okEnd,
      okNewline,
    ])
  })

  it('matches when the slash token is followed by punctuation', () => {
    // Real instructions often punctuate references: "run /task-triage, then..."
    // or "see /meeting-notes." — these still reference the target and the
    // dependents dialog should surface them.
    const target = 'task-triage'
    const comma = skill({ id: 'a', name: 'a', instruction: 'run /task-triage, then continue' })
    const period = skill({ id: 'b', name: 'b', instruction: 'See /task-triage.' })
    const paren = skill({ id: 'c', name: 'c', instruction: 'first (/task-triage) before next' })
    expect(findDependents(target, [skill({ id: 't', name: target }), comma, period, paren])).toEqual([
      comma,
      period,
      paren,
    ])
  })

  it('does not match a longer slug with the target as a prefix', () => {
    const target = 'foo'
    // `/foo-bar` is a different skill — must not be flagged as a dependent of `/foo`.
    const longer = skill({ id: 'lo', name: 'longer', instruction: 'reference to /foo-bar only' })
    expect(findDependents(target, [skill({ id: 't', name: target }), longer])).toEqual([])
  })

  it('does not match when the slash is missing (regression: spec stores bare slug)', () => {
    const target = 'foo'
    // Plain word "foo" in someone else's instruction should not count — the
    // chat trigger is `/foo`, not bare `foo`.
    const bare = skill({ id: 'b', name: 'b', instruction: 'mention foo here without slash' })
    expect(findDependents(target, [skill({ id: 't', name: target }), bare])).toEqual([])
  })

  it('escapes regex-special chars in the slug', () => {
    // The spec only allows [a-z0-9-], so '.+' won't actually appear in a valid
    // slug — but findDependents shouldn't trust that and should escape the
    // input. Test with a synthetic name to verify the escape path.
    const target = 'a.b'
    // 'aXb' must NOT match if '.' is treated as a regex wildcard. With proper
    // escaping it won't.
    const decoy = skill({ id: 'd', name: 'd', instruction: 'reference /aXb here' })
    expect(findDependents(target, [skill({ id: 't', name: target }), decoy])).toEqual([])
  })

  it('treats matching as case-sensitive (slugs are lowercase per spec)', () => {
    const target = 'meeting-notes'
    const wrongCase = skill({ id: 'w', name: 'w', instruction: 'see /Meeting-Notes' })
    expect(findDependents(target, [skill({ id: 't', name: target }), wrongCase])).toEqual([])
  })
})
