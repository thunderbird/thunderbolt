/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import {
  createSkillFormState,
  isSkillFormDirty,
  skillFormReducer,
  type SkillFormAction,
  type SkillFormState,
} from './use-skill-form-state'

const editValues = {
  name: 'daily-brief',
  label: 'Daily Brief',
  description: 'desc',
  instruction: 'do stuff',
}

const run = (state: SkillFormState, ...actions: SkillFormAction[]): SkillFormState =>
  actions.reduce(skillFormReducer, state)

describe('createSkillFormState', () => {
  it('starts create mode empty with the slug attached to Name auto-generation', () => {
    const state = createSkillFormState('create')
    expect(state).toEqual({
      mode: 'create',
      label: '',
      slug: '',
      description: '',
      instruction: '',
      isSlugDetached: false,
    })
  })

  it('starts detached when arriving with a pre-filled slug (create deep link)', () => {
    const state = createSkillFormState('create', {
      name: 'meeting-notes',
      label: 'Meeting Notes',
      description: '',
      instruction: '',
    })
    expect(state.slug).toBe('meeting-notes')
    expect(state.isSlugDetached).toBe(true)
  })

  it('starts detached in edit mode even when the initial slug is empty', () => {
    const state = createSkillFormState('edit', { ...editValues, name: '' })
    expect(state.isSlugDetached).toBe(true)
  })

  it('strips a leading / from legacy slugs', () => {
    const state = createSkillFormState('edit', { ...editValues, name: '/daily-brief' })
    expect(state.slug).toBe('daily-brief')
  })
})

describe('skillFormReducer — slug auto-generation', () => {
  it('typing the label regenerates the slug while attached', () => {
    const state = run(createSkillFormState('create'), { type: 'LABEL_CHANGED', value: 'Meeting Notes' })
    expect(state.label).toBe('Meeting Notes')
    expect(state.slug).toBe('meeting-notes')
    expect(state.isSlugDetached).toBe(false)
  })

  it('a direct slug edit detaches auto-generation', () => {
    const state = run(
      createSkillFormState('create'),
      { type: 'LABEL_CHANGED', value: 'Meeting Notes' },
      { type: 'SLUG_CHANGED', value: 'custom-slug' },
      { type: 'LABEL_CHANGED', value: 'Renamed' },
    )
    expect(state.isSlugDetached).toBe(true)
    expect(state.slug).toBe('custom-slug')
  })

  it('clearing the slug re-attaches and regenerates from the current label', () => {
    const state = run(
      createSkillFormState('create'),
      { type: 'LABEL_CHANGED', value: 'Meeting Notes' },
      { type: 'SLUG_CHANGED', value: 'custom-slug' },
      { type: 'SLUG_CHANGED', value: '' },
    )
    expect(state.isSlugDetached).toBe(false)
    expect(state.slug).toBe('meeting-notes')

    // …and keeps following the label afterwards.
    const next = run(state, { type: 'LABEL_CHANGED', value: 'Weekly Review' })
    expect(next.slug).toBe('weekly-review')
  })

  it('strips a leading / from a typed slug', () => {
    const state = run(createSkillFormState('create'), { type: 'SLUG_CHANGED', value: '/meeting-notes' })
    expect(state.slug).toBe('meeting-notes')
  })

  it('edit mode never auto-rewrites the slug, even after clearing it', () => {
    const cleared = run(
      createSkillFormState('edit', editValues),
      { type: 'LABEL_CHANGED', value: 'Rebranded Brief' },
      { type: 'SLUG_CHANGED', value: '' },
      { type: 'LABEL_CHANGED', value: 'Another Name' },
    )
    expect(cleared.slug).toBe('')
    expect(cleared.isSlugDetached).toBe(true)
  })
})

describe('skillFormReducer — description / instruction / reset', () => {
  it('records description and instruction edits', () => {
    const state = run(
      createSkillFormState('create'),
      { type: 'DESCRIPTION_CHANGED', value: 'when to use' },
      { type: 'INSTRUCTION_CHANGED', value: 'what to do' },
    )
    expect(state.description).toBe('when to use')
    expect(state.instruction).toBe('what to do')
  })

  it('RESET restores initial values and the detach state', () => {
    const dirty = run(
      createSkillFormState('edit', editValues),
      { type: 'LABEL_CHANGED', value: 'Changed' },
      { type: 'SLUG_CHANGED', value: 'changed-slug' },
      { type: 'DESCRIPTION_CHANGED', value: 'changed desc' },
      { type: 'INSTRUCTION_CHANGED', value: 'changed inst' },
    )
    const reset = run(dirty, { type: 'RESET', initialValues: editValues })
    expect(reset).toEqual(createSkillFormState('edit', editValues))
  })

  it('RESET on a blank create form re-attaches slug auto-generation', () => {
    const detached = run(createSkillFormState('create'), { type: 'SLUG_CHANGED', value: 'custom-slug' })
    expect(detached.isSlugDetached).toBe(true)

    const reset = run(detached, { type: 'RESET' })
    expect(reset.isSlugDetached).toBe(false)
    expect(reset.slug).toBe('')
  })
})

describe('isSkillFormDirty', () => {
  it('create mode: clean when all fields are empty, dirty once any field has content', () => {
    const initial = createSkillFormState('create')
    expect(isSkillFormDirty(initial, initial)).toBe(false)

    const typed = run(initial, { type: 'LABEL_CHANGED', value: 'X' })
    expect(isSkillFormDirty(typed, initial)).toBe(true)

    const described = run(initial, { type: 'DESCRIPTION_CHANGED', value: 'd' })
    expect(isSkillFormDirty(described, initial)).toBe(true)
  })

  it('create mode: returns to clean when the content is removed again', () => {
    const initial = createSkillFormState('create')
    const roundTrip = run(initial, { type: 'LABEL_CHANGED', value: 'X' }, { type: 'LABEL_CHANGED', value: '' })
    expect(isSkillFormDirty(roundTrip, initial)).toBe(false)
  })

  it('edit mode: clean at initial values, dirty on divergence, clean again when reverted', () => {
    const initial = createSkillFormState('edit', editValues)
    expect(isSkillFormDirty(initial, initial)).toBe(false)

    const changed = run(initial, { type: 'INSTRUCTION_CHANGED', value: 'other' })
    expect(isSkillFormDirty(changed, initial)).toBe(true)

    const reverted = run(changed, { type: 'INSTRUCTION_CHANGED', value: editValues.instruction })
    expect(isSkillFormDirty(reverted, initial)).toBe(false)
  })

  it('edit mode: a slug change alone marks the form dirty', () => {
    const initial = createSkillFormState('edit', editValues)
    const changed = run(initial, { type: 'SLUG_CHANGED', value: 'renamed-brief' })
    expect(isSkillFormDirty(changed, initial)).toBe(true)
  })
})
