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

  it('discloses the identified bounded-log upload before confirmation', () => {
    render(<ShareDebugTranscriptDialog {...defaultProps} />)

    expect(screen.getByText('This upload is identified and tied to your account. It is not anonymous.')).toBeVisible()
    expect(screen.getByText(/The conversation log \(older turns may be trimmed\) will be stored/)).toBeVisible()
    expect(screen.getByText(/The engineers who operate that server can read it for debugging/)).toBeVisible()
    const note = screen.getByLabelText('What went wrong? (optional)')
    expect(note).toHaveAttribute('maxlength', '2000')
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
