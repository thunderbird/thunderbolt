/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, test } from 'bun:test'
import { getActiveLocale, getBrowserLanguages, readInitialLocale, setActiveLocale } from './active-locale'

const storageKey = 'thunderbolt_locale'

afterEach(() => {
  localStorage.removeItem(storageKey)
})

describe('setActiveLocale', () => {
  test('publishes the locale to synchronous readers', () => {
    setActiveLocale('ja')
    expect(getActiveLocale()).toBe('ja')
  })

  test('mirrors the locale to localStorage for the next boot', () => {
    setActiveLocale('pt-BR')
    expect(localStorage.getItem(storageKey)).toBe('pt-BR')
  })

  test('the last write wins', () => {
    setActiveLocale('de')
    setActiveLocale('fr')
    expect(getActiveLocale()).toBe('fr')
    expect(localStorage.getItem(storageKey)).toBe('fr')
  })
})

describe('readInitialLocale', () => {
  test('returns the mirrored locale — a refresh must not fall back to en', () => {
    localStorage.setItem(storageKey, 'ja')
    expect(readInitialLocale()).toBe('ja')
  })

  test('mirror outranks browser languages, as the synced setting it copies does', () => {
    localStorage.setItem(storageKey, 'ja')
    // happy-dom reports `en-US`; the mirror must still win.
    expect(readInitialLocale()).not.toBe('en')
  })

  test('negotiates from the browser when no mirror exists', () => {
    expect(readInitialLocale()).toBe('en')
  })

  test('ignores a mirror holding an unshipped locale', () => {
    localStorage.setItem(storageKey, 'zh-CN')
    expect(readInitialLocale()).toBe('en')
  })

  test('ignores a corrupt mirror value', () => {
    localStorage.setItem(storageKey, 'not-a-locale')
    expect(readInitialLocale()).toBe('en')
  })
})

describe('getBrowserLanguages', () => {
  test('prefers the full preference list', () => {
    expect(getBrowserLanguages({ languages: ['ja', 'en'], language: 'en' })).toEqual(['ja', 'en'])
  })

  test('falls back to the single language when there is no list', () => {
    expect(getBrowserLanguages({ language: 'de-AT' })).toEqual(['de-AT'])
  })

  // Bun's `navigator` carries only `userAgent`, so returning `[navigator.language]`
  // unconditionally yields `[undefined]`, which crashes `resolveLocale`. This module
  // is imported at boot by src/lib/http.ts, which the Bun-run eval entrypoint pulls in.
  test('is empty on a navigator with no language fields (plain Bun)', () => {
    expect(getBrowserLanguages({})).toEqual([])
  })
})
