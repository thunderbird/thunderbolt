/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { negotiableLocales, resolveLocale, settableLocales } from './resolve-locale'

describe('resolveLocale', () => {
  test('explicit supported setting wins over browser languages', () => {
    expect(resolveLocale('ja', ['pt-BR', 'en'])).toBe('ja')
  })

  test('explicit pt-BR setting is returned as-is', () => {
    expect(resolveLocale('pt-BR', ['en'])).toBe('pt-BR')
  })

  // `language` is synced, so a dev-build selection would otherwise land on that
  // developer's production devices and render the whole UI as pseudo-text. Tests
  // run with `import.meta.env.DEV` unset, i.e. against the production contract.
  test('refuses the en-XA pseudo-locale outside dev builds', () => {
    expect(settableLocales).not.toContain('en-XA')
    expect(resolveLocale('en-XA', ['de'])).toBe('de')
  })

  test('unsupported setting falls through to browser negotiation', () => {
    expect(resolveLocale('zh-CN', ['fr-FR', 'en'])).toBe('fr')
  })

  test('null setting uses the first matching browser language', () => {
    expect(resolveLocale(null, ['de-DE', 'en-US'])).toBe('de')
  })

  test('matches exact regional tags', () => {
    expect(resolveLocale(null, ['pt-BR'])).toBe('pt-BR')
  })

  test('maps base language to the regional shipped locale (pt → pt-BR)', () => {
    expect(resolveLocale(null, ['pt'])).toBe('pt-BR')
  })

  test('maps sibling regions to the shipped locale (pt-PT → pt-BR)', () => {
    expect(resolveLocale(null, ['pt-PT'])).toBe('pt-BR')
  })

  test('strips regions when only the base is shipped (en-GB → en)', () => {
    expect(resolveLocale(null, ['en-GB'])).toBe('en')
  })

  test('is case-insensitive on browser tags', () => {
    expect(resolveLocale(null, ['PT-br'])).toBe('pt-BR')
    expect(resolveLocale(null, ['JA'])).toBe('ja')
  })

  test('skips unsupported browser languages until one matches', () => {
    expect(resolveLocale(null, ['zh-CN', 'ko', 'es-MX'])).toBe('es')
  })

  test('falls back to en when nothing matches', () => {
    expect(resolveLocale(null, ['zh-CN', 'ko'])).toBe('en')
  })

  test('falls back to en on an empty browser list', () => {
    expect(resolveLocale(null, [])).toBe('en')
  })

  test('never negotiates the en-XA pseudo-locale from the browser', () => {
    expect(resolveLocale(null, ['en-XA'])).toBe('en')
    expect(negotiableLocales).not.toContain('en-XA')
  })
})
