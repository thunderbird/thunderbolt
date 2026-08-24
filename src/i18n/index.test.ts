/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, test } from 'bun:test'
import { getActiveLocale, setActiveLocale } from './active-locale'
import { applyLanguageSetting } from './index'

afterEach(() => {
  setActiveLocale('en')
  localStorage.removeItem('thunderbolt_locale')
})

describe('applyLanguageSetting', () => {
  /**
   * The regression guard for the header lagging a language change by one
   * request: writing the `language` setting queues a PowerSync CRUD upload that
   * reads `X-App-Language` before React can run an effect, so the publish has to
   * land before this promise settles — not after the catalog chunk loads.
   */
  test('publishes the locale without waiting on the returned promise', () => {
    const pending = applyLanguageSetting('pt-BR')

    expect(getActiveLocale()).toBe('pt-BR')

    return pending
  })

  test('treats null as auto and negotiates from the browser', async () => {
    await applyLanguageSetting('pt-BR')

    await applyLanguageSetting(null)

    // happy-dom reports en-US.
    expect(getActiveLocale()).toBe('en')
  })

  test('falls back rather than activating an unshipped locale', async () => {
    await applyLanguageSetting('zh-CN')

    expect(getActiveLocale()).toBe('en')
  })

  test('mirrors the change so the next page load starts from it', async () => {
    await applyLanguageSetting('ja')

    expect(localStorage.getItem('thunderbolt_locale')).toBe('ja')
  })
})
