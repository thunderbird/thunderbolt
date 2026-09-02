/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getEmailI18n, resolveEmailLocale } from './i18n'

describe('resolveEmailLocale', () => {
  it('accepts a shipped locale', () => {
    expect(resolveEmailLocale('de')).toBe('de')
  })

  it('accepts a region-qualified locale the app ships', () => {
    expect(resolveEmailLocale('pt-BR')).toBe('pt-BR')
  })

  it('refuses the pseudo-locale over the wire', () => {
    // `/v1/waitlist/join` is unauthenticated and takes the recipient from the
    // body, so honouring this would let anyone mail a third party gibberish.
    // The preview and render tests reach en-XA through getEmailI18n directly.
    expect(resolveEmailLocale('en-XA')).toBe('en')
  })

  it('falls back to the source locale for a tag the app ships no catalog for', () => {
    expect(resolveEmailLocale('nl')).toBe('en')
  })

  it('does not widen a region tag to its base language', () => {
    // The client has already negotiated, so the header carries a resolved tag.
    // Re-negotiating here would silently disagree with the UI the user is
    // looking at; an unshipped tag is an English email instead.
    expect(resolveEmailLocale('de-AT')).toBe('en')
  })

  it('falls back when the header is absent', () => {
    expect(resolveEmailLocale(null)).toBe('en')
  })

  it('falls back when there is no request behind the send', () => {
    expect(resolveEmailLocale(undefined)).toBe('en')
  })
})

describe('getEmailI18n', () => {
  it('reports the locale it was built for', () => {
    expect(getEmailI18n('de').locale).toBe('de')
    expect(getEmailI18n('ja').locale).toBe('ja')
  })

  it('memoizes one instance per locale', () => {
    expect(getEmailI18n('fr')).toBe(getEmailI18n('fr'))
  })

  it('keeps locales on separate instances so concurrent sends cannot leak', () => {
    expect(getEmailI18n('fr')).not.toBe(getEmailI18n('es'))
  })

  it('resolves a message against its own catalog', () => {
    // `en-XA` is pseudo-localized at compile time, so it is the one locale with
    // real translations before Pontoon lands (THU-827) — which makes it the
    // only honest end-to-end check that lookups hit the compiled catalog.
    const source = getEmailI18n('en')._({ id: 'Sign In' })
    const pseudo = getEmailI18n('en-XA')._({ id: 'Sign In' })

    expect(source).toBe('Sign In')
    expect(pseudo).not.toBe(source)
  })
})
