/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { McpBridgeConnectDialog } from './mcp-bridge-connect-dialog'

const writeTextMock = mock((_text: string) => Promise.resolve())
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  configurable: true,
})

afterEach(() => {
  cleanup()
  writeTextMock.mockClear()
})

describe('McpBridgeConnectDialog', () => {
  it('renders the install step and waits for a command before showing the run command', () => {
    render(<McpBridgeConnectDialog open={true} onOpenChange={() => {}} />)

    expect(screen.getByText(/connect a local mcp server via bridge/i)).toBeInTheDocument()
    expect(screen.getByText(/curl -fsSL/)).toBeInTheDocument()
    // No run command until the user enters their stdio launch command.
    expect(screen.queryByTestId('copyable-command-copy-run')).not.toBeInTheDocument()
    expect(screen.getByText(/enter the command above/i)).toBeInTheDocument()
  })

  it('composes the --mode mcp run command from the typed stdio command', () => {
    render(<McpBridgeConnectDialog open={true} onOpenChange={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText(/server-everything stdio/i), {
      target: { value: 'npx @modelcontextprotocol/server-everything stdio' },
    })

    expect(
      screen.getByText('thunderbolt bridge --mode mcp -- npx @modelcontextprotocol/server-everything stdio'),
    ).toBeInTheDocument()
  })

  it('copies the composed run command to the clipboard', async () => {
    render(<McpBridgeConnectDialog open={true} onOpenChange={() => {}} />)

    fireEvent.change(screen.getByPlaceholderText(/server-everything stdio/i), {
      target: { value: 'uvx mcp-server' },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('copyable-command-copy-run'))
    })

    expect(writeTextMock).toHaveBeenCalledWith('thunderbolt bridge --mode mcp -- uvx mcp-server')
  })

  it('invokes onOpenChange(false) when Done is clicked', () => {
    const onOpenChange = mock(() => {})
    render(<McpBridgeConnectDialog open={true} onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByRole('button', { name: /done/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
