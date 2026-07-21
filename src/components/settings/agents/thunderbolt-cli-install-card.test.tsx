/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { getClock } from '@/testing-library'
import type { CliInstallError, CliInstallResult } from '@/lib/cli-install'
import { ThunderboltCliInstallCard } from './thunderbolt-cli-install-card'

const writeTextMock = mock(() => Promise.resolve())
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  configurable: true,
})

afterEach(() => {
  cleanup()
  writeTextMock.mockClear()
})

const renderCard = (props: Partial<Parameters<typeof ThunderboltCliInstallCard>[0]> = {}) =>
  render(<ThunderboltCliInstallCard platform="macos" architecture="aarch64" tauri={true} {...props} />)

const clickInstall = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /install cli/i }))
    await getClock().runAllAsync()
  })
}

describe('ThunderboltCliInstallCard', () => {
  it('renders the install action on Tauri desktop macOS/Linux', () => {
    renderCard()
    expect(screen.getByRole('button', { name: /install cli/i })).toBeInTheDocument()
  })

  it('renders the install guide on web instead of the one-click install action', () => {
    renderCard({ tauri: false })

    const guideLink = screen.getByRole('link', { name: /view install guide/i })
    expect(guideLink).toHaveAttribute(
      'href',
      'https://github.com/thunderbird/thunderbolt/blob/main/cli/README.md#install',
    )
    expect(guideLink).toHaveAttribute('target', '_blank')
    expect(guideLink).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText(/install the standalone/i)).toHaveTextContent('from your shell')
    expect(screen.queryByRole('button', { name: /install cli/i })).not.toBeInTheDocument()
  })

  it('renders nothing on unsupported Tauri platforms', () => {
    const { container: windows } = renderCard({ platform: 'windows' })
    expect(windows).toBeEmptyDOMElement()
    cleanup()
    const { container: mobile } = renderCard({ platform: 'ios' })
    expect(mobile).toBeEmptyDOMElement()
  })

  it('renders nothing on Intel macOS because no binary is published', () => {
    const { container } = renderCard({ architecture: 'x86_64' })
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the installed path on success', async () => {
    const result: CliInstallResult = { path: '/home/u/.local/bin/thunderbolt', onPath: true, pathHint: null }
    renderCard({ install: () => Promise.resolve(result) })

    await clickInstall()

    expect(screen.getByText('/home/u/.local/bin/thunderbolt')).toBeInTheDocument()
    expect(screen.queryByText(/add.*to your PATH/i)).not.toBeInTheDocument()
  })

  it('surfaces the PATH hint when the install dir is not on PATH', async () => {
    const hint = 'export PATH="$HOME/.local/bin:$PATH"'
    const result: CliInstallResult = { path: '/home/u/.local/bin/thunderbolt', onPath: false, pathHint: hint }
    renderCard({ install: () => Promise.resolve(result) })

    await clickInstall()

    expect(screen.getByText(hint)).toBeInTheDocument()
    expect(screen.getByText(/add.*to your PATH/i)).toBeInTheDocument()
  })

  it('shows the error message and the manual build fallback for an unpublished release', async () => {
    const error: CliInstallError = { kind: 'notPublished', message: 'This release has no prebuilt CLI yet.' }
    renderCard({ install: () => Promise.reject(error) })

    await clickInstall()

    expect(screen.getByText('This release has no prebuilt CLI yet.')).toBeInTheDocument()
    expect(screen.getByText('cd cli && bun install && bun run build && ./install.sh')).toBeInTheDocument()
  })

  it('shows the error without the build fallback for an operational failure', async () => {
    const error: CliInstallError = { kind: 'checksumMismatch', message: 'Checksum mismatch. Install aborted.' }
    renderCard({ install: () => Promise.reject(error) })

    await clickInstall()

    expect(screen.getByText('Checksum mismatch. Install aborted.')).toBeInTheDocument()
    expect(screen.queryByText(/build it from source/i)).not.toBeInTheDocument()
  })
})
