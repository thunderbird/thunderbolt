/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { ReactElement } from 'react'
import { render } from 'react-email'
import type { AppLocale } from '@shared/i18n/locales'
import { getEmailI18n } from './i18n'
import { MagicLinkEmail, magicLinkSubject } from './magic-link'
import { WaitlistJoinedEmail, waitlistJoinedSubject } from './waitlist-joined'
import { WaitlistNotReadyEmail, waitlistNotReadySubject } from './waitlist-not-ready'
import { WaitlistReminderEmail, waitlistReminderSubject } from './waitlist-reminder'

/** react-email escapes apostrophes, so decode before matching against source copy. */
const renderCopy = async (element: ReactElement): Promise<string> => (await render(element)).replaceAll('&#x27;', "'")

const magicLink = (locale: AppLocale) => (
  <MagicLinkEmail i18n={getEmailI18n(locale)} code="882999" magicLinkUrl="https://example.test/verify" />
)

/**
 * Only `en-XA` carries translations today — it is pseudo-localized from the
 * English source at compile time, while the shipped locales stay untranslated
 * until Pontoon lands (THU-827) and fall back to English. So the pseudo-locale
 * is what proves a lookup actually reaches the compiled catalog, and `de` is
 * what proves the locale reaches the markup.
 */
describe('email rendering', () => {
  it('renders the English source copy', async () => {
    const html = await renderCopy(magicLink('en'))

    expect(html).toContain('lang="en"')
    expect(html).toContain('Use the code below to sign in, or click the button.')
    expect(html).toContain('882999')
  })

  it('tags the document with the recipient’s language', async () => {
    expect(await renderCopy(magicLink('de'))).toContain('lang="de"')
    expect(await renderCopy(magicLink('ja'))).toContain('lang="ja"')
  })

  it('resolves body copy through the catalog rather than hardcoding English', async () => {
    const html = await renderCopy(magicLink('en-XA'))

    expect(html).toContain('lang="en-XA"')
    expect(html).not.toContain('Use the code below to sign in, or click the button.')
  })

  it('localizes the shared layout footer', async () => {
    expect(await renderCopy(magicLink('en'))).toContain('You can reply to this email')
    expect(await renderCopy(magicLink('en-XA'))).not.toContain('You can reply to this email')
  })

  it.each([
    ['waitlist-joined', WaitlistJoinedEmail, 'Thanks for signing up!'],
    ['waitlist-not-ready', WaitlistNotReadyEmail, 'Not quite ready yet!'],
    ['waitlist-reminder', WaitlistReminderEmail, "You're already on the waitlist!"],
  ])('keeps %s copy unchanged in English', async (_name, Email, heading) => {
    const html = await renderCopy(<Email i18n={getEmailI18n('en')} />)

    expect(html).toContain(heading)
    expect(html).toContain('The Thunderbolt Team')
  })

  it.each([
    ['waitlist-joined', WaitlistJoinedEmail, 'Thanks for signing up!'],
    ['waitlist-not-ready', WaitlistNotReadyEmail, 'Not quite ready yet!'],
    ['waitlist-reminder', WaitlistReminderEmail, "You're already on the waitlist!"],
  ])('resolves %s body copy through the catalog', async (_name, Email, heading) => {
    const html = await renderCopy(<Email i18n={getEmailI18n('en-XA')} />)

    expect(html).toContain('lang="en-XA"')
    expect(html).not.toContain(heading)
    expect(html).not.toContain('The Thunderbolt Team')
  })

  it.each([
    ['magic link', magicLinkSubject],
    ['waitlist joined', waitlistJoinedSubject],
    ['waitlist not ready', waitlistNotReadySubject],
    ['waitlist reminder', waitlistReminderSubject],
  ])('localizes the %s subject', (_name, subject) => {
    expect(subject(getEmailI18n('en-XA'))).not.toBe(subject(getEmailI18n('en')))
  })
})
