/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import { MiniAppDownloadPrompt, saveArmDelayMs } from './mini-app-download-prompt'

const elapse = async (ms: number) => {
  await act(async () => {
    await getClock().tickAsync(ms)
  })
}

describe('MiniAppDownloadPrompt', () => {
  afterEach(() => {
    cleanup()
  })

  it('names the app and the file', () => {
    render(<MiniAppDownloadPrompt appName="Finance" download={{ name: 'report.pdf' }} onAnswer={() => {}} />)

    expect(screen.getByText('Save a file from Finance?')).toBeInTheDocument()
    expect(screen.getByText('Your browser will download report.pdf.')).toBeInTheDocument()
  })

  /** Otherwise the second click of a double-click could approve a file nobody read. */
  it('holds Save off for a moment after it opens', async () => {
    const onAnswer = mock()
    render(<MiniAppDownloadPrompt appName="Finance" download={{ name: 'report.pdf' }} onAnswer={onAnswer} />)
    const save = screen.getByRole('button', { name: 'Save' })

    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onAnswer).not.toHaveBeenCalled()

    await elapse(saveArmDelayMs)

    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(onAnswer).toHaveBeenCalledWith(true)
  })

  /** A new request is a new prompt: it is not armed by the one before it. */
  it('disarms again for the next file', async () => {
    const { rerender } = render(
      <MiniAppDownloadPrompt appName="Finance" download={{ name: 'a.pdf' }} onAnswer={() => {}} />,
    )
    await elapse(saveArmDelayMs)

    rerender(<MiniAppDownloadPrompt appName="Finance" download={{ name: 'b.pdf' }} onAnswer={() => {}} />)

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('lets the user decline at once', () => {
    const onAnswer = mock()
    render(<MiniAppDownloadPrompt appName="Finance" download={{ name: 'report.pdf' }} onAnswer={onAnswer} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onAnswer).toHaveBeenCalledWith(false)
  })
})
