/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { ShareDebugTranscriptButton } from './share-debug-transcript-button'

afterEach(cleanup)

describe('ShareDebugTranscriptButton', () => {
  it('shares directly and names the enabled action in a tooltip', () => {
    const onShare = mock()
    render(<ShareDebugTranscriptButton disabledReason={null} onShare={onShare} />)

    const button = screen.getByRole('button', { name: 'Share debug transcript' })
    fireEvent.click(button)
    expect(onShare).toHaveBeenCalledTimes(1)

    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Share debug transcript')
  })

  it('keeps the same focused button across disabled-state transitions', () => {
    const { rerender } = render(
      <ShareDebugTranscriptButton disabledReason="Wait for the response to finish" onShare={() => {}} />,
    )
    const button = screen.getByRole('button', { name: 'Share debug transcript' })
    button.focus()

    rerender(<ShareDebugTranscriptButton disabledReason={null} onShare={() => {}} />)

    expect(screen.getByRole('button', { name: 'Share debug transcript' })).toBe(button)
    expect(document.activeElement).toBe(button)
  })

  it('never shares from click, Enter, or Space while disabled', () => {
    const onShare = mock()
    render(<ShareDebugTranscriptButton disabledReason="Wait for the response to finish" onShare={onShare} />)
    const button = screen.getByRole('button', { name: 'Share debug transcript' })

    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: ' ' })

    expect(onShare).not.toHaveBeenCalled()
  })

  for (const reason of ['Wait for the response to finish', 'Available once the conversation has messages']) {
    it(`explains why sharing is disabled on focus and tap: ${reason}`, async () => {
      render(<ShareDebugTranscriptButton disabledReason={reason} onShare={() => {}} />)

      const button = screen.getByRole('button', { name: 'Share debug transcript' })
      expect(button).toHaveAttribute('aria-disabled', 'true')
      const descriptionId = button.getAttribute('aria-describedby')
      expect(descriptionId).not.toBeNull()
      expect(document.getElementById(descriptionId ?? '')).toHaveTextContent(reason)

      fireEvent.focus(button)
      expect(await screen.findByRole('tooltip')).toHaveTextContent(reason)

      fireEvent.blur(button)
      fireEvent.click(button)
      expect(await screen.findByRole('tooltip')).toHaveTextContent(reason)
    })
  }
})
