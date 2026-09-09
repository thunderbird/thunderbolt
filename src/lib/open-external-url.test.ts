/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import { openExternalUrl } from './open-external-url'

const originalOpen = window.open

const stubWindowOpen = (impl: () => Window | null) => {
  const spy = mock(impl)
  window.open = spy as typeof window.open
  return spy
}

afterEach(() => {
  window.open = originalOpen
})

describe('openExternalUrl on web', () => {
  const webDeps = { isTauri: () => false, openInTauri: mock(async () => {}) }

  it('opens a new tab with noopener,noreferrer', async () => {
    const windowOpen = stubWindowOpen(() => ({}) as Window)

    await openExternalUrl('https://example.com', webDeps)

    expect(windowOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(webDeps.openInTauri).not.toHaveBeenCalled()
  })

  it('resolves when window.open returns null (noopener returns null on success)', async () => {
    stubWindowOpen(() => null)

    // Must not throw: a null return is not a failure signal, so we can't treat it as one.
    await openExternalUrl('https://example.com', webDeps)
  })

  it('rejects when window.open throws', async () => {
    window.open = mock(() => {
      throw new Error('blocked')
    }) as unknown as typeof window.open

    await expect(openExternalUrl('https://example.com', webDeps)).rejects.toThrow('blocked')
  })
})

describe('openExternalUrl under Tauri', () => {
  it('delegates to the Tauri opener and never touches window.open', async () => {
    const windowOpen = stubWindowOpen(() => ({}) as Window)
    const openInTauri = mock(async () => {})

    await openExternalUrl('https://example.com', { isTauri: () => true, openInTauri })

    expect(openInTauri).toHaveBeenCalledWith('https://example.com')
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('rejects when the Tauri opener rejects, so callers can surface an error', async () => {
    const windowOpen = stubWindowOpen(() => ({}) as Window)
    const openInTauri = mock(async () => {
      throw new Error('opener failed')
    })

    await expect(openExternalUrl('https://example.com', { isTauri: () => true, openInTauri })).rejects.toThrow(
      'opener failed',
    )
    // No silent web fallback — the dialog flow depends on the rejection.
    expect(windowOpen).not.toHaveBeenCalled()
  })
})
