/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as updater from '@/hooks/use-desktop-update'
import * as platform from '@/lib/platform'
import * as opener from '@tauri-apps/plugin-opener'
import { AppVersionSection } from './app-version-section'

const spies: { mockRestore: () => void }[] = []
afterEach(() => {
  cleanup()
  spies.reverse().forEach((spy) => spy.mockRestore())
  spies.length = 0
})

const setup = (
  status: updater.UpdateStatus,
  {
    desktop = true,
    enabled = true,
    mobile = false,
    tauri = true,
    errorPhase = null,
  }: {
    desktop?: boolean
    enabled?: boolean
    mobile?: boolean
    tauri?: boolean
    errorPhase?: updater.UpdateErrorPhase | null
  } = {},
) => {
  const primaryAction = mock(async () => {})
  const checkForUpdates = mock(async () => {})
  spies.push(
    spyOn(platform, 'isDesktop').mockReturnValue(desktop),
    spyOn(platform, 'isTauri').mockReturnValue(tauri),
    spyOn(platform, 'isMobile').mockReturnValue(mobile),
    spyOn(updater, 'useDesktopUpdate').mockReturnValue({
      ...updater.initialUpdateState,
      status,
      enabled,
      errorPhase,
      primaryAction,
      checkForUpdates,
      downloadAndInstall: mock(async () => {}),
      restartApp: mock(async () => {}),
    }),
  )
  return { primaryAction, checkForUpdates }
}

describe('Settings update recovery', () => {
  it.each([
    ['initial', 'Check for updates'],
    ['idle', 'Check for updates'],
    ['available', 'Download update'],
    ['ready', 'Restart to update'],
    ['error', 'Retry'],
  ] as const)('runs the shared primary action in %s', (status, label) => {
    const { primaryAction } = setup(status)
    render(<AppVersionSection />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(primaryAction).toHaveBeenCalledTimes(1)
  })

  it.each(['checking', 'downloading', 'restarting'] as const)('disables actions while %s', (status) => {
    const { primaryAction } = setup(status)
    render(<AppVersionSection />)
    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(primaryAction).not.toHaveBeenCalled()
  })

  it('keeps mobile updates directed to the app store', () => {
    const { primaryAction } = setup('ready', { desktop: false, mobile: true })
    spies.push(spyOn(platform, 'getPlatform').mockReturnValue('ios'))
    const open = spyOn(opener, 'openUrl').mockResolvedValue()
    spies.push(open)
    render(<AppVersionSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(primaryAction).not.toHaveBeenCalled()
  })

  it('does not offer desktop update actions on the web', () => {
    setup('available', { tauri: false })
    render(<AppVersionSection />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the app version without update controls in development builds', () => {
    const { primaryAction, checkForUpdates } = setup('initial', { enabled: false })
    render(<AppVersionSection />)
    expect(screen.getByText('Current version')).toBeInTheDocument()
    expect(screen.queryByText('Updates')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(primaryAction).not.toHaveBeenCalled()
    expect(checkForUpdates).not.toHaveBeenCalled()
  })
})

it.each(['available', 'error'] as const)('offers a fresh manifest check in %s before installation', (status) => {
  const { primaryAction, checkForUpdates } = setup(status, { errorPhase: status === 'error' ? 'download' : null })
  render(<AppVersionSection />)
  fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
  expect(checkForUpdates).toHaveBeenCalledTimes(1)
  expect(primaryAction).not.toHaveBeenCalled()
})
