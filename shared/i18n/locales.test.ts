/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { appLocales, englishLanguageName, pseudoLocale, sourceLocale } from './locales'

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
