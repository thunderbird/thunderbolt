/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, mock } from 'bun:test'
import type { AskData } from './lib'
import { type AskSubmission, useAskState } from './use-ask-state'

const single: AskData = {
  prompt: 'Which protocol sends outgoing mail?',
  mode: 'single',
  options: [
    { id: 'smtp', text: 'SMTP', isCorrect: true },
    { id: 'imap', text: 'IMAP' },
  ],
}

const choice: AskData = {
  prompt: 'What next?',
  mode: 'choice',
  options: [
    { id: 'draft', text: 'Draft a reply' },
    { id: 'archive', text: 'Archive' },
  ],
}

const choices: AskData = { ...choice, prompt: 'Which do you like?', mode: 'choices' }

type Input = Parameters<typeof useAskState>[0]

const setup = (input: Input) => {
  const onSubmit = mock((_: AskSubmission) => {})
  const hook = renderHook((props: Input) => useAskState(props), { initialProps: { ...input, onSubmit } })
  return { ...hook, onSubmit }
}

describe('useAskState', () => {
  it('grades a single-answer question on the tap, once, even on a fast second tap', () => {
    const { result, onSubmit } = setup(single)

    act(() => {
      result.current.toggleOption('imap')
      result.current.toggleOption('smtp')
    })

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual({ selectedIds: ['imap'], matched: false })
    expect(result.current).toMatchObject({ showsGrade: true, locked: true, showSubmit: false, announcedMatch: false })
  })

  it('shows a choice pick without committing it, and commits it once on the action button', () => {
    const { result, onSubmit } = setup(choice)

    act(() => result.current.toggleOption('draft'))
    act(() => result.current.toggleOption('archive'))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({ showSubmit: true, canSubmit: true, answered: false })
    expect([...result.current.selected]).toEqual(['archive'])

    act(() => {
      result.current.submit()
      result.current.submit()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual({ selectedIds: ['archive'], matched: null })
  })

  it('re-commits an answered ungraded question only for a different answer', () => {
    const { result, onSubmit } = setup({ ...choice, initialSelectedIds: ['draft'], initialSubmitted: true })
    expect(result.current.showSubmit).toBe(false)

    act(() => result.current.toggleOption('draft'))
    expect(result.current.showSubmit).toBe(false)

    act(() => result.current.toggleOption('archive'))
    act(() => result.current.submit())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['archive'] })
    expect(result.current.locked).toBe(false)
  })

  it('offers Submit again on an answered choices step only once its selection changes', () => {
    const { result } = setup({ ...choices, initialSelectedIds: ['draft'], initialSubmitted: true })
    expect(result.current.showSubmit).toBe(false)

    act(() => result.current.toggleOption('archive'))
    expect(result.current.showSubmit).toBe(true)
  })

  it('a locked card shows the saved answer, not the pending selection, and ignores clicks', () => {
    const saved = { ...choices, initialSelectedIds: ['draft'], initialSubmitted: true }
    const { result, rerender, onSubmit } = setup(saved)

    act(() => result.current.toggleOption('archive'))
    expect([...result.current.selected]).toEqual(['draft', 'archive'])

    rerender({ ...saved, readOnly: true, onSubmit })
    expect([...result.current.selected]).toEqual(['draft'])
    expect(result.current).toMatchObject({ locked: true, showSubmit: false })

    act(() => result.current.toggleOption('archive'))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  describe('"Other…"', () => {
    it('is offered on ungraded modes only', () => {
      expect(setup(single).result.current.offersOther).toBe(false)
      expect(setup(choice).result.current.offersOther).toBe(true)
    })

    it('replaces the pick in choice, and is replaced by one, committing on the action button', () => {
      const { result, onSubmit } = setup(choice)

      act(() => result.current.toggleOption('draft'))
      act(() => result.current.toggleOther())
      expect(result.current).toMatchObject({ other: true })
      expect([...result.current.selected]).toEqual([])

      act(() => result.current.toggleOption('archive'))
      expect(result.current.other).toBe(false)

      act(() => result.current.toggleOther())
      expect(onSubmit).not.toHaveBeenCalled()
      act(() => result.current.submit())
      expect(onSubmit.mock.calls[0][0]).toEqual({ selectedIds: [], matched: null, other: true })
    })

    it('toggles alongside the options for choices and goes with Submit', () => {
      const { result, onSubmit } = setup(choices)

      act(() => result.current.toggleOther())
      expect(onSubmit).not.toHaveBeenCalled()
      expect(result.current.canSubmit).toBe(true)
      act(() => result.current.toggleOption('archive'))
      act(() => result.current.submit())

      expect(onSubmit.mock.calls[0][0]).toEqual({ selectedIds: ['archive'], matched: null, other: true })
    })
  })

  describe('Skip', () => {
    it('is offered only when the question can be skipped and the card is open', () => {
      expect(setup(single).result.current.showSkip).toBe(false)
      expect(setup({ ...single, canSkip: true }).result.current.showSkip).toBe(true)
      expect(setup({ ...single, canSkip: true, readOnly: true }).result.current.showSkip).toBe(false)
    })

    it('commits a skip, which grades nothing', () => {
      const { result, onSubmit } = setup({ ...single, canSkip: true })

      act(() => result.current.skip())

      expect(onSubmit.mock.calls[0][0]).toEqual({ selectedIds: [], matched: null, skipped: true })
      expect(result.current).toMatchObject({ skipped: true, showsGrade: false, showSkip: false, answered: true })
    })

    it('a skipped step counts as saved until something is picked, then the pick replaces the skip', () => {
      const { result, onSubmit } = setup({ ...choices, canSkip: true, initialSubmitted: true, initialSkipped: true })
      expect(result.current).toMatchObject({ skipped: true, showSubmit: false, showSkip: false, answered: true })

      act(() => result.current.toggleOption('draft'))
      expect(result.current).toMatchObject({ showSubmit: true, canSubmit: true })
      act(() => result.current.submit())
      expect(onSubmit.mock.calls[0][0]).toEqual({ selectedIds: ['draft'], matched: null })
    })

    it('a skipped graded question restores ungraded and can still be answered', () => {
      const { result, onSubmit } = setup({ ...single, canSkip: true, initialSubmitted: true, initialSkipped: true })
      expect(result.current).toMatchObject({ skipped: true, showsGrade: false, locked: false })

      act(() => result.current.toggleOption('smtp'))
      act(() => result.current.submit())
      expect(onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['smtp'], matched: true })
    })
  })

  it('announces only a grade given on this card, not a restored one', () => {
    expect(
      setup({ ...single, initialSelectedIds: ['smtp'], initialSubmitted: true }).result.current.announcedMatch,
    ).toBe(null)
  })

  describe('just after the step is reached by navigating', () => {
    it('ignores taps, Submit and Skip until the window ends, then answers', () => {
      const until = Date.now() + 400
      const graded = setup({ ...single, ignoreAnswersUntil: until })
      act(() => graded.result.current.toggleOption('smtp'))
      expect(graded.onSubmit).not.toHaveBeenCalled()

      const input = setup({ ...choices, canSkip: true, ignoreAnswersUntil: until })
      act(() => input.result.current.toggleOption('draft'))
      act(() => input.result.current.skip())
      expect([...input.result.current.selected]).toEqual([])
      expect(input.onSubmit).not.toHaveBeenCalled()

      act(() => getClock().tick(400))
      act(() => graded.result.current.toggleOption('smtp'))
      expect(graded.onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['smtp'], matched: true })
      act(() => input.result.current.skip())
      expect(input.onSubmit.mock.calls[0][0]).toMatchObject({ skipped: true })
    })
  })
})
