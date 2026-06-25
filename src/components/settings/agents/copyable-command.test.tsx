/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { CopyableCommand } from './copyable-command'

const writeTextMock = mock(() => Promise.resolve())
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  configurable: true,
})

afterEach(() => {
  cleanup()
  writeTextMock.mockClear()
})

describe('CopyableCommand', () => {
  it('renders the command text', () => {
    render(<CopyableCommand command="npx thunderbolt-stdio-bridge --help" />)
    expect(screen.getByText('npx thunderbolt-stdio-bridge --help')).toBeInTheDocument()
  })

  it('copies the command and flips the button label to Copied', async () => {
    render(<CopyableCommand command="echo hi" />)

    const button = screen.getByRole('button', { name: /copy command/i })
    await act(async () => {
      fireEvent.click(button)
    })

    expect(writeTextMock).toHaveBeenCalledWith('echo hi')
    expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument()
  })

  it('suffixes the copy button testid when testId is provided', () => {
    render(<CopyableCommand command="x" testId="install" />)
    expect(screen.getByTestId('copyable-command-copy-install')).toBeInTheDocument()
  })
})
