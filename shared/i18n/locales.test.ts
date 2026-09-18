/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import {
  appLocales,
  englishLanguageName,
  matchExactLocale,
  negotiableLocales,
  pseudoLocale,
  sourceLocale,
} from './locales'

describe('negotiableLocales', () => {
  // Pinned as a literal rather than recomputed from `appLocales`: recomputing
  // the filter mirrors a wrong predicate on both sides and can never fail, and
  // shipping a locale should require a deliberate edit here.
  test('is the shipped set without the pseudo-locale', () => {
    expect(negotiableLocales).toEqual(['en', 'de', 'fr', 'es', 'pt-BR', 'ja'])
  })
})

describe('matchExactLocale', () => {
  test('returns the shipped tag for an exact match', () => {
    expect(matchExactLocale('pt-BR')).toBe('pt-BR')
    expect(matchExactLocale('ja')).toBe('ja')
  })

  // Returning the set's own tag rather than the caller's string is what keeps a
  // crafted header out of the outbound request; the casing swap here shows it.
  test('normalizes casing and surrounding whitespace', () => {
    expect(matchExactLocale('PT-br')).toBe('pt-BR')
    expect(matchExactLocale(' pt-BR ')).toBe('pt-BR')
  })

  test('rejects the pseudo-locale, which only a dev build can send', () => {
    expect(matchExactLocale('en-XA')).toBeNull()
  })

  test('rejects a tag we ship no catalog for', () => {
    expect(matchExactLocale('zh-CN')).toBeNull()
  })

  // Frontend negotiation falls back to the base language; this deliberately does not.
  test('does not fall back to the base language', () => {
    expect(matchExactLocale('pt-PT')).toBeNull()
    expect(matchExactLocale('de-AT')).toBeNull()
  })

  test('rejects absent and malformed values', () => {
    expect(matchExactLocale(null)).toBeNull()
    expect(matchExactLocale(undefined)).toBeNull()
    expect(matchExactLocale('')).toBeNull()
    expect(matchExactLocale('   ')).toBeNull()
    expect(matchExactLocale('de\r\nX-Injected: 1')).toBeNull()
  })
})

describe('englishLanguageName', () => {
  test('names a language in English rather than in itself', () => {
    expect(englishLanguageName('de')).toBe('German')
    expect(englishLanguageName('ja')).toBe('Japanese')
    expect(englishLanguageName('en')).toBe('English')
  })

  test('names a regional locale without dropping the language', () => {
    // "Brazilian Portuguese" or "Portuguese (Brazil)" depending on the ICU build.
    expect(englishLanguageName('pt-BR')).toContain('Portuguese')
  })

  test('names the pseudo-locale as plain English', () => {
    // CLDR says "English (Pseudo-Accents)", which describes the glyph mangling and is
    // not a language a model could answer in.
    expect(englishLanguageName(pseudoLocale)).toBe(englishLanguageName(sourceLocale))
  })

  test('names every shipped locale', () => {
    for (const locale of appLocales) {
      expect(englishLanguageName(locale)).not.toBe(locale)
    }
  })
})
