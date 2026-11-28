/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Ask } from './display'
import type { AskSubmission } from './use-ask-state'
import type { AskData } from './lib'

const single: AskData = {
  prompt: 'Which protocol sends outgoing mail?',
  mode: 'single',
  explanation: 'SMTP handles sending; IMAP and POP3 retrieve mail.',
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

const pressed = (text: string) => screen.getByText(text).closest('button')?.getAttribute('aria-pressed')
const isDisabled = (text: string) => (screen.getByText(text).closest('button') as HTMLButtonElement).disabled

describe('Ask — display', () => {
  afterEach(cleanup)

  it('grades a single-answer question on the tap, without a Submit or assessment language', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(<Ask {...single} onSubmit={onSubmit} />)

    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
    fireEvent.click(screen.getByText('SMTP'))

    // Records the match for internal use…
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['smtp'], matched: true })

    // …but surfaces no "Correct!/Not quite/Score/grade" wording to the user.
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/correct!|not quite|score|grade/i)
    // The neutral explanation panel is shown instead.
    expect(text).toContain('SMTP handles sending')
  })

  it('marks a non-matching selection without calling it wrong', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(<Ask {...single} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByText('IMAP'))

    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['imap'], matched: false })
    expect(document.body.textContent ?? '').not.toMatch(/not quite|incorrect/i)
  })

  it('a single-answer double tap grades once', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(<Ask {...single} onSubmit={onSubmit} />)

    const option = screen.getByText('IMAP')
    fireEvent.click(option)
    fireEvent.click(option)
    fireEvent.click(screen.getByText('SMTP'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('choice mode: shows the pick highlighted, changeable, and commits it on the action button', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(<Ask {...choice} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByText('Draft a reply'))
    fireEvent.click(screen.getByText('Archive'))
    expect(onSubmit).not.toHaveBeenCalled()
    expect([pressed('Draft a reply'), pressed('Archive')]).toEqual(['false', 'true'])
    expect(isDisabled('Archive')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit.mock.calls[0][0]).toEqual({ selectedIds: ['archive'], matched: null })
  })

  it('choice mode: "Other…" replaces the pick, and a pick replaces "Other…"', () => {
    render(<Ask {...choice} />)

    fireEvent.click(screen.getByText('Draft a reply'))
    fireEvent.click(screen.getByText('Other…'))
    expect([pressed('Draft a reply'), pressed('Other…')]).toEqual(['false', 'true'])

    fireEvent.click(screen.getByText('Archive'))
    expect([pressed('Archive'), pressed('Other…')]).toEqual(['true', 'false'])
  })

  describe('the action button', () => {
    it('reads Next on an ungraded step with a step after it, and Submit on the last step or a lone ask', () => {
      const { rerender } = render(<Ask {...choice} progress={{ step: 1, total: 3 }} />)
      fireEvent.click(screen.getByText('Archive'))
      expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()

      rerender(<Ask {...choice} progress={{ step: 3, total: 3 }} />)
      expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy()
      cleanup()

      render(<Ask {...choice} />)
      fireEvent.click(screen.getByText('Archive'))
      expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy()
    })

    it('reads Submit on a graded multiple-answer step, even with a step after it', () => {
      render(
        <Ask
          prompt="Pick the standards"
          mode="multiple"
          options={[
            { id: 'pgp', text: 'OpenPGP', isCorrect: true },
            { id: 'b64', text: 'Base64' },
          ]}
          progress={{ step: 1, total: 3 }}
        />,
      )
      fireEvent.click(screen.getByText('OpenPGP'))
      expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy()
    })

    it('sits below the explanation on a graded step', () => {
      render(<Ask {...single} progress={{ step: 1, total: 2 }} onNext={() => {}} />)
      fireEvent.click(screen.getByText('SMTP'))

      const explanation = screen.getByText(single.explanation ?? '')
      const next = screen.getByRole('button', { name: 'Next' })
      expect(explanation.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })

  it('choices mode: allows multiple selections and commits them together on submit', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(
      <Ask
        prompt="Which of these do you like?"
        mode="choices"
        options={[
          { id: 'coffee', text: 'Coffee' },
          { id: 'tea', text: 'Tea' },
          { id: 'neither', text: 'Neither' },
        ]}
        onSubmit={onSubmit}
      />,
    )

    // Selecting one option does not commit — a multi-select waits for Submit.
    fireEvent.click(screen.getByText('Coffee'))
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Tea'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    // Both picks recorded, and no right/wrong verdict (ungraded).
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['coffee', 'tea'], matched: null })
    expect(document.body.textContent ?? '').not.toMatch(/correct!|incorrect|not quite|score/i)
  })

  it('restores a previously-submitted response', () => {
    render(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted />)
    // Already submitted → no Submit button, explanation shown.
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
    expect(document.body.textContent ?? '').toContain('SMTP handles sending')
  })

  it('shows the step control, each arrow enabled only with somewhere to go', () => {
    const onPrevious = mock(() => {})
    const onNext = mock(() => {})
    const { rerender } = render(<Ask {...single} progress={{ step: 2, total: 4 }} onPrevious={onPrevious} />)

    expect(screen.getByText('Question 2 of 4')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Next question' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Previous question' }))
    expect(onPrevious).toHaveBeenCalledTimes(1)

    rerender(<Ask {...single} progress={{ step: 2, total: 4 }} onNext={onNext} />)
    expect((screen.getByRole('button', { name: 'Previous question' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Next question' }))
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('a lone ask shows no step control', () => {
    render(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted />)

    expect(document.body.textContent ?? '').not.toContain('Question')
    expect(screen.queryByRole('button', { name: 'Next question' })).toBeNull()
  })

  it('a sequence step describes its prompt with the step label and takes focus when navigated to', () => {
    render(<Ask {...single} progress={{ step: 2, total: 4 }} focusPrompt />)

    const prompt = screen.getByText(single.prompt)
    expect(document.activeElement).toBe(prompt)
    expect(document.getElementById(prompt.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Question 2 of 4')
  })

  it('does not steal focus on mount unless navigated to', () => {
    render(<Ask {...single} progress={{ step: 1, total: 4 }} />)

    expect(document.activeElement).not.toBe(screen.getByText(single.prompt))
  })

  it('offers "See all answers" once the last step is submitted', () => {
    const onReview = mock(() => {})
    render(<Ask {...single} progress={{ step: 4, total: 4 }} onReview={onReview} />)

    expect(screen.queryByRole('button', { name: 'See all answers' })).toBeNull()
    fireEvent.click(screen.getByText('SMTP'))

    expect(document.body.textContent ?? '').toContain('SMTP handles sending')
    fireEvent.click(screen.getByRole('button', { name: 'See all answers' }))
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('puts "See all answers" in the action row, before the other buttons (on the left)', () => {
    render(
      <Ask
        prompt="Which do you like?"
        mode="choices"
        options={[
          { id: 'coffee', text: 'Coffee' },
          { id: 'tea', text: 'Tea' },
        ]}
        progress={{ step: 2, total: 2 }}
        initialSelectedIds={['coffee']}
        initialSubmitted
        onReview={() => {}}
      />,
    )
    // Editing the answered last step brings Submit back beside "See all answers".
    fireEvent.click(screen.getByText('Tea'))
    const review = screen.getByRole('button', { name: 'See all answers' })
    const submit = screen.getByRole('button', { name: 'Submit' })

    expect(review.parentElement).toBe(submit.parentElement)
    expect([...(review.parentElement?.children ?? [])].indexOf(review)).toBe(0)
  })

  it('shows the sent note only when told the answers were sent, in any mode', () => {
    const { rerender } = render(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted />)
    expect(screen.queryByText('Got it, working on that next.')).toBeNull()

    rerender(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted sendStatus="sending" />)
    expect(screen.queryByText('Got it, working on that next.')).toBeNull()

    rerender(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted sendStatus="sent" />)
    expect(screen.getByText('Got it, working on that next.')).toBeTruthy()
  })

  it('a failed send says so and offers to resend', () => {
    const onRetrySend = mock(() => {})
    render(
      <Ask {...single} initialSelectedIds={['smtp']} initialSubmitted sendStatus="failed" onRetrySend={onRetrySend} />,
    )

    expect(screen.queryByText('Got it, working on that next.')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('couldn’t be sent')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetrySend).toHaveBeenCalledTimes(1)
  })

  it('multiple mode keeps Submit and offers no "Other…"', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(
      <Ask
        prompt="Pick the standards"
        mode="multiple"
        options={[
          { id: 'pgp', text: 'OpenPGP', isCorrect: true },
          { id: 'b64', text: 'Base64' },
        ]}
        onSubmit={onSubmit}
      />,
    )

    expect(screen.queryByText('Other…')).toBeNull()
    fireEvent.click(screen.getByText('OpenPGP'))
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['pgp'], matched: true })
  })

  describe('Skip', () => {
    it('shows only when the question can be skipped, and commits a skip', () => {
      const onSubmit = mock((_: AskSubmission) => {})
      const { rerender } = render(<Ask {...single} onSubmit={onSubmit} />)
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()

      rerender(<Ask {...single} canSkip onSubmit={onSubmit} />)
      fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

      expect(onSubmit.mock.calls[0][0]).toEqual({ selectedIds: [], matched: null, skipped: true })
      expect(screen.getByText('Skipped')).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
    })

    it('is not offered once the answers are sent', () => {
      render(<Ask {...single} canSkip initialSubmitted initialSkipped readOnly />)
      expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()
      expect((screen.getByText('SMTP').closest('button') as HTMLButtonElement).disabled).toBe(true)
    })
  })

  it('shows no note when the request failed inside the chat, which shows its own error', () => {
    render(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted sendStatus="failed-in-chat" />)
    expect(screen.queryByText('Got it, working on that next.')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('points to the message box once an "Other…" answer was handed to it', () => {
    render(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted sendStatus="handed-off" />)
    expect(screen.getByText('Finish your answer in the message box.')).toBeTruthy()
  })

  describe('accessibility', () => {
    it('announces a grade given here, in neutral words, but not a restored one', () => {
      const { unmount } = render(<Ask {...single} />)
      const region = () => document.querySelector('[aria-live="polite"]')
      expect(region()?.textContent).toBe('')

      fireEvent.click(screen.getByText('IMAP'))
      expect(region()?.textContent).toBe("Doesn't match the answer")
      unmount()

      render(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted />)
      expect(region()?.textContent).toBe('')
    })

    it('exposes the selected state of each option, "Other…" included', () => {
      render(
        <Ask
          prompt="Which do you like?"
          mode="choices"
          options={[
            { id: 'coffee', text: 'Coffee' },
            { id: 'tea', text: 'Tea' },
          ]}
        />,
      )

      fireEvent.click(screen.getByText('Tea'))
      fireEvent.click(screen.getByText('Other…'))
      expect([pressed('Coffee'), pressed('Tea'), pressed('Other…')]).toEqual(['false', 'true', 'true'])
    })

    it('a graded answer moves focus to the Next button under it, or to the prompt on the last step', () => {
      const { unmount } = render(<Ask {...single} progress={{ step: 1, total: 2 }} onNext={() => {}} />)
      fireEvent.click(screen.getByText('SMTP'))
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
      unmount()

      render(<Ask {...single} progress={{ step: 2, total: 2 }} />)
      fireEvent.click(screen.getByText('SMTP'))
      expect(document.activeElement).toBe(screen.getByText(single.prompt))
    })

    it('shows Next under an answered step that has a next one, and not before it is answered', () => {
      const onNext = mock(() => {})
      render(<Ask {...single} progress={{ step: 1, total: 2 }} onNext={onNext} />)
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()

      fireEvent.click(screen.getByText('SMTP'))
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
      expect(onNext).toHaveBeenCalledTimes(1)
    })
  })
})
