/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { detectEmbedded } from './embed'
import * as platform from './platform'

/** happy-dom ignores `history.replaceState` for `location`; its control API sets the URL. */
const setUrl = (url: string) =>
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url)

describe('detectEmbedded', () => {
  beforeEach(() => {
    localStorage.clear()
    setUrl('https://example.com/')
  })

  afterEach(() => {
    localStorage.clear()
    setUrl('https://example.com/')
  })

  it('is false for a plain browser visit', () => {
    expect(detectEmbedded()).toBe(false)
  })

  it('is true when the URL carries ?embed=app', () => {
    setUrl('https://example.com/?embed=app')
    expect(detectEmbedded()).toBe(true)
  })

  it('ignores other embed values', () => {
    setUrl('https://example.com/?embed=other')
    expect(detectEmbedded()).toBe(false)
  })

  it('keeps the marker after the query string is gone', () => {
    setUrl('https://example.com/?embed=app')
    detectEmbedded()
    setUrl('https://example.com/chats/new')
    expect(detectEmbedded()).toBe(true)
  })

  describe('when localStorage throws', () => {
    const realStorage = window.localStorage
    const fail = () => {
      throw new Error('SecurityError')
    }

    beforeEach(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: fail, setItem: fail } })
    })

    afterEach(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: realStorage })
    })

    it('counts the current ?embed=app query', () => {
      setUrl('https://example.com/?embed=app')
      expect(detectEmbedded()).toBe(true)
    })

    it('is false without the query', () => {
      expect(detectEmbedded()).toBe(false)
    })
  })

  it('is never true inside Tauri, even with the marker', () => {
    const spy = spyOn(platform, 'isTauri').mockReturnValue(true)
    setUrl('https://example.com/?embed=app')
    expect(detectEmbedded()).toBe(false)
    spy.mockRestore()
  })
})
