/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { ShareDebugTranscriptDialog } from './share-debug-transcript-dialog'

const defaultProps = {
  open: true,
  userNote: '',
  errorMessage: null,
  isPending: false,
  onOpenChange: () => {},
  onCancel: () => {},
  onUserNoteChange: () => {},
  onSubmit: () => {},
}

describe('ShareDebugTranscriptDialog', () => {
  afterEach(cleanup)

  it('presents every consent fact in the accessible description', () => {
    render(<ShareDebugTranscriptDialog {...defaultProps} />)

    const dialog = screen.getByRole('dialog', { name: 'Show the Thunderbolt team what happened?' })
    expect(dialog).toBeVisible()
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining('tool calls'))
    expect(
      screen.getByText(
        'This sends the debug transcript to the Thunderbolt team — exactly what the agent did, step by step — so they can work out what went wrong.',
      ),
    ).toBeVisible()

    const whoQuestion = screen.getByText('Who can read it?')
    expect(whoQuestion.tagName).toBe('DT')
    expect(
      screen.getByText(
        "The Thunderbolt team, plus whoever operates the server you're connected to, for debugging. It's tied to your account — it isn't anonymous.",
      ),
    ).toBeVisible()

    const contentsQuestion = screen.getByText("What's in it?")
    expect(contentsQuestion.tagName).toBe('DT')
    expect(
      screen.getByText(
        'Your prompts, system prompts, tool calls with their inputs and outputs, errors, and timestamps. Older turns may be trimmed.',
      ),
    ).toBeVisible()

    const storageQuestion = screen.getByText('Where is it kept?')
    expect(storageQuestion.tagName).toBe('DT')
    expect(screen.getByText('On the connected server, in plaintext, until you delete your account.')).toBeVisible()

    const facts = whoQuestion.closest('dl')
    if (!facts) {
      throw new Error('Consent facts must render as a description list')
    }
    expect(facts.querySelectorAll('dt')).toHaveLength(3)
  })

  it('focuses the note first and associates it with its label', () => {
    render(<ShareDebugTranscriptDialog {...defaultProps} />)

    const label = screen.getByText('Tell them what happened (optional)', { selector: 'label' })
    const note = screen.getByLabelText('Tell them what happened (optional)')
    expect(note).toHaveFocus()
    expect(note.id === label.getAttribute('for')).toBe(true)
    expect(note).toHaveAttribute('maxlength', '2000')
    expect(note).toHaveAttribute(
      'placeholder',
      'In your own words: what were you trying to do, and what did the agent do instead?',
    )
    expect(note).not.toHaveAttribute('rows')
  })

  it('orders the consent facts before the note', () => {
    render(<ShareDebugTranscriptDialog {...defaultProps} />)

    const facts = screen.getByText('Who can read it?').closest('dl')
    if (!facts) {
      throw new Error('Consent facts must render as a description list')
    }
    const note = screen.getByLabelText('Tell them what happened (optional)')
    expect(facts.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('submits only from the explicit confirmation action', () => {
    const onOpenChange = mock()
    const onSubmit = mock()
    render(<ShareDebugTranscriptDialog {...defaultProps} onOpenChange={onOpenChange} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send to the Thunderbolt team' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps a failed submission visible and offers retry', () => {
    render(<ShareDebugTranscriptDialog {...defaultProps} errorMessage="Could not send." />)

    expect(screen.getByRole('alert')).toHaveTextContent('Could not send.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('keeps cancellation available while disabling confirmation during sending', () => {
    const onCancel = mock()
    const onSubmit = mock()
    render(<ShareDebugTranscriptDialog {...defaultProps} isPending onCancel={onCancel} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  })
})
