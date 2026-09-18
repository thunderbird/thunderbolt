/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { pseudoLocale } from '@shared/i18n/locales'
import { describe, expect, it } from 'bun:test'
import { languageLabel, languageOptions } from './language-options'
import { settableLocales } from './resolve-locale'

describe('languageOptions', () => {
  /**
   * The picker must not be able to offer a locale the resolver would refuse —
   * the two lists used to disagree, which is how the pseudo-locale synced to
   * production devices (THU-807). Deriving from `settableLocales` is the fix;
   * this pins the derivation.
   */
  it('offers exactly the settable locales, in order', () => {
    expect(languageOptions.map((option) => option.value)).toEqual([...settableLocales])
  })

  it('labels each language by its capitalized endonym', () => {
    const labels = Object.fromEntries(languageOptions.map((option) => [option.value, option.label]))

    expect(labels.en).toBe('English')
    expect(labels.de).toBe('Deutsch')
    expect(labels.fr).toBe('Français')
    expect(labels.es).toBe('Español')
    expect(labels.ja).toBe('日本語')
  })

  /**
   * `Intl.DisplayNames` has no endonym for a made-up tag, and the pseudo-locale
   * only exists in dev builds — when present it carries the hardcoded label
   * rather than whatever ICU improvises for `en-XA`.
   */
  it('never lets the pseudo-locale carry an ICU-derived label', () => {
    const pseudoOption = languageOptions.find((option) => option.value === pseudoLocale)
    if (pseudoOption) {
      expect(pseudoOption.label).toBe('Pseudo-locale (en-XA)')
    }
  })
})

describe('languageLabel', () => {
  it('returns the endonym for a shipped locale', () => {
    expect(languageLabel('de')).toBe('Deutsch')
  })

  it('falls back to the tag itself for an unshipped locale', () => {
    expect(languageLabel('zh-CN')).toBe('zh-CN')
  })
})
