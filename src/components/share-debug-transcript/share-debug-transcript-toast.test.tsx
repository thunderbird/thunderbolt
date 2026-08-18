/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { getClock } from '@/testing-library'
import { ShareDebugTranscriptToast } from './share-debug-transcript-toast'

const successMessage = 'Sent — thank you. This helps the Thunderbolt team see exactly what happened.'

describe('ShareDebugTranscriptToast', () => {
  afterEach(cleanup)

  it('keeps a permanent polite live region and swaps its message', () => {
    const { rerender } = render(<ShareDebugTranscriptToast open={false} onDismiss={() => {}} />)

    expect(screen.getByRole('status')).toHaveTextContent('')

    rerender(<ShareDebugTranscriptToast open onDismiss={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent(successMessage)
    expect(screen.getAllByText(successMessage)).toHaveLength(2)
  })

  it('dismisses after four seconds and restarts after reopening', async () => {
    const onDismiss = mock()
    const { rerender } = render(<ShareDebugTranscriptToast open onDismiss={onDismiss} />)

    await act(async () => {
      await getClock().tickAsync(3_000)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    rerender(<ShareDebugTranscriptToast open={false} onDismiss={onDismiss} />)
    rerender(<ShareDebugTranscriptToast open onDismiss={onDismiss} />)

    await act(async () => {
      await getClock().tickAsync(3_999)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    await act(async () => {
      await getClock().tickAsync(1)
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
