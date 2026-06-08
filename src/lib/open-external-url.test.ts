/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { openExternalUrl } from './open-external-url'

// In the test environment `window.isTauri` is absent, so isTauri() is false and
// openExternalUrl takes the web (window.open) branch.
describe('openExternalUrl', () => {
  it('opens a safe https URL in a new tab with noopener,noreferrer', async () => {
    const originalOpen = window.open
    const mockWindowOpen = mock(() => null)
    window.open = mockWindowOpen as typeof window.open

    await openExternalUrl('https://dash.tinfoil.sh/?tab=billing')

    expect(mockWindowOpen).toHaveBeenCalledWith('https://dash.tinfoil.sh/?tab=billing', '_blank', 'noopener,noreferrer')

    window.open = originalOpen
  })

  it('refuses to open an unsafe (javascript:) URL', async () => {
    const originalOpen = window.open
    const mockWindowOpen = mock(() => null)
    window.open = mockWindowOpen as typeof window.open

    await openExternalUrl('javascript:alert(1)')

    expect(mockWindowOpen).not.toHaveBeenCalled()

    window.open = originalOpen
  })

  it('refuses to open a malformed URL', async () => {
    const originalOpen = window.open
    const mockWindowOpen = mock(() => null)
    window.open = mockWindowOpen as typeof window.open

    await openExternalUrl('not a url')

    expect(mockWindowOpen).not.toHaveBeenCalled()

    window.open = originalOpen
  })
})
