/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { AgentInstallMeta } from '@/defaults/agent-install-metadata'
import type { RegistryEntry } from '@/types/registry'
import { AgentInstallDialog } from './agent-install-dialog'

const writeTextMock = mock(() => Promise.resolve())
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  configurable: true,
})

afterEach(() => {
  cleanup()
  writeTextMock.mockClear()
})

const entry = (overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id: 'gemini',
  name: 'Gemini CLI',
  version: '1.0.0',
  description: 'desc',
  authors: ['Google'],
  license: 'Apache-2.0',
  distribution: { npx: { package: '@google/gemini-cli@1.0.0', args: ['--acp'] } },
  ...overrides,
})

const renderDialog = (props: Partial<Parameters<typeof AgentInstallDialog>[0]> = {}) =>
  render(<AgentInstallDialog entry={entry()} open={true} onOpenChange={() => {}} platform="macos" {...props} />)

describe('AgentInstallDialog', () => {
  it('renders the derived run command', () => {
    renderDialog()
    expect(screen.getByText('npx -y @google/gemini-cli@1.0.0 --acp')).toBeInTheDocument()
  })

  it('resolves the binary command for the given platform', () => {
    const binaryEntry = entry({
      distribution: {
        binary: {
          'darwin-aarch64': { cmd: './amp-acp' },
          'windows-x86_64': { cmd: 'amp-acp.exe' },
        },
      },
    })
    renderDialog({ entry: binaryEntry, platform: 'windows' })
    expect(screen.getByText('amp-acp.exe')).toBeInTheDocument()
  })

  it('renders authored env vars and the setup guide link when meta is present', () => {
    const meta: AgentInstallMeta = {
      requiredEnv: [{ name: 'GEMINI_API_KEY', description: 'API key from Google AI Studio.' }],
      docsUrl: 'https://example.com/docs',
    }
    renderDialog({ meta })

    expect(screen.getByText('GEMINI_API_KEY')).toBeInTheDocument()
    expect(screen.getByText(/required setup/i)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /setup guide/i })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
  })

  it('hides the setup panel when no meta is provided', () => {
    renderDialog()
    expect(screen.queryByText(/required setup/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /setup guide/i })).not.toBeInTheDocument()
  })

  it('copies the command and toggles the button icon on click', async () => {
    renderDialog()
    const copyButton = screen.getByRole('button', { name: /copy run command/i })

    await act(async () => {
      fireEvent.click(copyButton)
    })

    expect(writeTextMock).toHaveBeenCalledWith('npx -y @google/gemini-cli@1.0.0 --acp')
    // The check icon replaces the copy icon while `isCopied` is true.
    expect(copyButton.querySelector('.text-green-600')).toBeInTheDocument()
  })
})
