/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Ask, type AskSubmission } from './display'
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

describe('Ask — display', () => {
  afterEach(cleanup)

  it('reveals the designated answer on submit without assessment language', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(<Ask {...single} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByText('SMTP'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['imap'], matched: false })
    expect(document.body.textContent ?? '').not.toMatch(/not quite|incorrect/i)
  })

  it('choice mode: commits immediately on selection with no designated answer', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(
      <Ask
        prompt="What next?"
        mode="choice"
        options={[
          { id: 'draft', text: 'Draft a reply' },
          { id: 'archive', text: 'Archive' },
        ]}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.click(screen.getByText('Draft a reply'))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ selectedIds: ['draft'], matched: null })
  })

  it('choice mode: rapid double-click commits only once', () => {
    const onSubmit = mock((_: AskSubmission) => {})
    render(
      <Ask prompt="What next?" mode="choice" options={[{ id: 'draft', text: 'Draft a reply' }]} onSubmit={onSubmit} />,
    )

    const option = screen.getByText('Draft a reply')
    fireEvent.click(option)
    fireEvent.click(option)

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('restores a previously-submitted response', () => {
    render(<Ask {...single} initialSelectedIds={['smtp']} initialSubmitted />)
    // Already submitted → no Submit button, explanation shown.
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
    expect(document.body.textContent ?? '').toContain('SMTP handles sending')
  })
})
