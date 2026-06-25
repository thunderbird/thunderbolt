/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { RegistryDistribution, RegistryEntry } from '@/types/registry'
import { BridgeConnectDialog } from './bridge-connect-dialog'

const writeTextMock = mock((_text: string) => Promise.resolve())
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  configurable: true,
})

afterEach(() => {
  cleanup()
  writeTextMock.mockClear()
})

const entryWith = (distribution: RegistryDistribution, overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id: 'gemini',
  name: 'Gemini',
  version: '0.46.0',
  description: 'Google Gemini CLI',
  authors: ['Google'],
  license: 'Apache-2.0',
  website: 'https://example.com/gemini',
  repository: 'https://github.com/example/gemini',
  distribution,
  ...overrides,
})

const npxEntry = entryWith({ npx: { package: '@google/gemini-cli@0.46.0', args: ['--acp'] } })
const binaryEntry = entryWith(
  { binary: { 'darwin-aarch64': { cmd: './goose', args: ['acp'] } } },
  { id: 'goose', name: 'Goose' },
)

describe('BridgeConnectDialog — npx agent', () => {
  it('renders the three connect steps and the bridge command', () => {
    render(<BridgeConnectDialog entry={npxEntry} open={true} onOpenChange={() => {}} />)

    expect(screen.getByText(/connect gemini via bridge/i)).toBeInTheDocument()
    // Install command and the bridge run command both appear.
    expect(screen.getByText(/curl -fsSL/)).toBeInTheDocument()
    expect(
      screen.getByText('npx thunderbolt-stdio-bridge --mode acp -- npx @google/gemini-cli@0.46.0 --acp'),
    ).toBeInTheDocument()
    // Step 3 directs the user to Add custom agent.
    expect(screen.getByText(/add custom agent/i)).toBeInTheDocument()
  })

  it('copies the bridge run command to the clipboard', async () => {
    render(<BridgeConnectDialog entry={npxEntry} open={true} onOpenChange={() => {}} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('copyable-command-copy-run'))
    })

    expect(writeTextMock).toHaveBeenCalledWith(
      'npx thunderbolt-stdio-bridge --mode acp -- npx @google/gemini-cli@0.46.0 --acp',
    )
  })

  it('copies the install command to the clipboard', async () => {
    render(<BridgeConnectDialog entry={npxEntry} open={true} onOpenChange={() => {}} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('copyable-command-copy-install'))
    })

    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock.mock.calls[0][0].startsWith('curl -fsSL')).toBe(true)
  })

  it('invokes onOpenChange(false) when Done is clicked', () => {
    const onOpenChange = mock(() => {})
    render(<BridgeConnectDialog entry={npxEntry} open={true} onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByRole('button', { name: /done/i }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('BridgeConnectDialog — binary agent', () => {
  it('renders the binary fallback instead of the run command', () => {
    render(<BridgeConnectDialog entry={binaryEntry} open={true} onOpenChange={() => {}} />)

    // No bridge run command for a binary-only agent.
    expect(screen.queryByTestId('copyable-command-copy-run')).not.toBeInTheDocument()
    expect(screen.getByText(/ships as a platform binary/i)).toBeInTheDocument()
    // Points the user at the agent's own instructions.
    expect(screen.getByRole('link', { name: /agent instructions/i })).toHaveAttribute(
      'href',
      'https://example.com/gemini',
    )
  })
})
