/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from 'bun:test'
import type { Skill } from '@/types'
import { cloudComposerSkills, mergeVisibleSkillPinOrder } from './composer-skills'

const skill = (id: string): Skill => ({
  id,
  name: id,
  label: null,
  description: '',
  instruction: 'edited locally',
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
})
const saved = (sourceId: string) => ({
  sourceId,
  name: sourceId,
  description: 'Saved description',
  instruction: 'Saved instructions',
})

it('exposes only saved, enabled, existing skills with the saved instruction snapshot', () => {
  const library = [
    skill('selected'),
    skill('unselected'),
    skill('disabled'),
    { ...skill('deleted'), deletedAt: '2026-10-23' },
  ]
  expect(
    cloudComposerSkills(library, ['selected', 'disabled', 'deleted', 'missing'].map(saved), (id) => id !== 'disabled'),
  ).toEqual([{ ...library[0], description: 'Saved description', instruction: 'Saved instructions' }])
  expect(cloudComposerSkills(library, [], () => true)).toEqual([])
})

it('matches legacy saved skill names without falling back from an explicit missing source ID', () => {
  expect(
    cloudComposerSkills(
      [skill('selected')],
      [{ name: 'selected', description: '', instruction: 'Saved' }],
      () => true,
    )[0]?.instruction,
  ).toBe('Saved')
  expect(cloudComposerSkills([skill('selected')], [{ ...saved('missing'), name: 'selected' }], () => true)).toEqual([])
})

it('reorders only visible pin positions and preserves hidden pins and widget positions', () => {
  expect(mergeVisibleSkillPinOrder(['widget', 'a', 'hidden', 'b'], ['b', 'a'])).toEqual(['widget', 'b', 'hidden', 'a'])
  expect(mergeVisibleSkillPinOrder(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a'])
})
