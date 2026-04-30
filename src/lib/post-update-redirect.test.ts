/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { setPostUpdateFlag, handlePostUpdateRedirect } from './post-update-redirect'

const mockLocation = (pathname: string) => {
  const replaceSpy = mock()
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname, replace: replaceSpy },
    writable: true,
    configurable: true,
  })
  return replaceSpy
}

describe('setPostUpdateFlag', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('sets the post-update flag in localStorage', () => {
    setPostUpdateFlag()
    expect(localStorage.getItem('thunderbolt_post_update')).toBe('1')
  })
})

describe('handlePostUpdateRedirect', () => {
  const originalLocation = window.location

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  it('returns false when no flag is set', () => {
    mockLocation('/')
    expect(handlePostUpdateRedirect()).toBe(false)
  })

  it('removes the flag and returns false when already on root', () => {
    localStorage.setItem('thunderbolt_post_update', '1')
    mockLocation('/')
    expect(handlePostUpdateRedirect()).toBe(false)
    expect(localStorage.getItem('thunderbolt_post_update')).toBeNull()
  })

  it('removes the flag, redirects to root, and returns true when on a non-root path', () => {
    localStorage.setItem('thunderbolt_post_update', '1')
    const replaceSpy = mockLocation('/waitlist/verify')

    expect(handlePostUpdateRedirect()).toBe(true)
    expect(replaceSpy).toHaveBeenCalledWith('/')
    expect(localStorage.getItem('thunderbolt_post_update')).toBeNull()
  })

  it('returns false without flag even on a non-root path', () => {
    mockLocation('/settings')
    expect(handlePostUpdateRedirect()).toBe(false)
  })
})
