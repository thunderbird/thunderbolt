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

  it('presents every consent fact as scannable lines', () => {
    render(<ShareDebugTranscriptDialog {...defaultProps} />)

    expect(screen.getByText('Identified upload.').parentElement).toHaveTextContent(
      'Identified upload. This is tied to your account and is not anonymous.',
    )
    expect(screen.getByText('Conversation data.').parentElement).toHaveTextContent(
      'Conversation data. Includes your prompts, system prompts, tool calls with inputs and outputs, errors, and timestamps.',
    )
    expect(screen.getByText('Stored on the connected server.').parentElement).toHaveTextContent(
      'Stored on the connected server. The engineers who operate this server can read the transcript for debugging.',
    )
    expect(screen.getByText('Older turns may be trimmed.')).not.toHaveClass('text-[length:var(--font-size-xs)]')
    const note = screen.getByLabelText('What went wrong? (optional)')
    expect(note).toHaveAttribute('maxlength', '2000')
    expect(note).toHaveAttribute(
      'placeholder',
      'Describe the problem to help the engineers who operate this server investigate.',
    )
    expect(note).not.toHaveAttribute('rows')
    expect(note.id).not.toBe('debug-transcript-user-note')
  })

  it('submits without closing the controlled dialog before the request settles', () => {
    const onOpenChange = mock()
    const onSubmit = mock()
    render(<ShareDebugTranscriptDialog {...defaultProps} onOpenChange={onOpenChange} onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send transcript' }))

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
    render(<ShareDebugTranscriptDialog {...defaultProps} isPending onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  })
})
