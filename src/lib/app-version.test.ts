/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { appVersionHeader } from './app-version'

const env = import.meta.env as Record<string, unknown>

describe('appVersionHeader', () => {
  let saved: unknown

  beforeEach(() => {
    saved = env.VITE_APP_VERSION
  })

  afterEach(() => {
    env.VITE_APP_VERSION = saved
  })

  it('returns the X-App-Version header when VITE_APP_VERSION is set', () => {
    env.VITE_APP_VERSION = '1.2.3'
    expect(appVersionHeader()).toEqual({ 'X-App-Version': '1.2.3' })
  })

  it('returns an empty object when VITE_APP_VERSION is unset', () => {
    env.VITE_APP_VERSION = undefined
    expect(appVersionHeader()).toEqual({})
  })

  it('returns an empty object for an empty-string version', () => {
    env.VITE_APP_VERSION = ''
    expect(appVersionHeader()).toEqual({})
  })
})
