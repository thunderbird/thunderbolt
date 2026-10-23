/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactElement } from 'react'
import { render } from 'react-email'
import type { AppLocale } from '@shared/i18n/locales'
import { clearSettingsCache } from '@/config/settings'
import { stepUpCopy } from '@/lib/security-notifications'
import type { StepUpAction } from '@/lib/step-up-otp'
import { getEmailI18n } from './i18n'
import { MagicLinkEmail, magicLinkSubject } from './magic-link'
import { SecurityCodeEmail } from './security-code'
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
// The emails read the app name from settings, so pin BRANDING_JSON rather than
// inheriting whatever the developer's .env sets.
const savedBranding = process.env.BRANDING_JSON

beforeAll(() => {
  delete process.env.BRANDING_JSON
  clearSettingsCache()
})

afterAll(() => {
  if (savedBranding === undefined) {
    delete process.env.BRANDING_JSON
  } else {
    process.env.BRANDING_JSON = savedBranding
  }
  clearSettingsCache()
})

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

  describe('step-up code', () => {
    const stepUpEmail = (action: StepUpAction, locale: AppLocale) => {
      const i18n = getEmailI18n(locale)
      const { subject, body, guidance } = stepUpCopy[action](i18n, 'MacBook Pro')
      return renderCopy(
        <SecurityCodeEmail i18n={i18n} code="88299917" preview={subject} body={body} guidance={guidance} />,
      )
    }

    it('renders each action’s own English copy', async () => {
      const deletion = await stepUpEmail('account-deletion', 'en')
      expect(deletion).toContain('Deletion of your account was requested from device')
      expect(deletion).toContain('88299917')
      expect(deletion).not.toContain('recovery phrase change was requested')

      expect(await stepUpEmail('recovery-phrase-change', 'en')).toContain(
        'A recovery phrase change was requested from device',
      )
    })

    it('resolves each action’s copy through the catalog', async () => {
      expect(await stepUpEmail('account-deletion', 'en-XA')).not.toContain(
        'Deletion of your account was requested from device',
      )
      expect(await stepUpEmail('recovery-phrase-change', 'en-XA')).not.toContain(
        'A recovery phrase change was requested from device',
      )
    })
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

describe('branded email rendering', () => {
  beforeEach(() => {
    process.env.BRANDING_JSON = JSON.stringify({ appName: 'Acme AI' })
    clearSettingsCache()
  })

  afterEach(() => {
    delete process.env.BRANDING_JSON
    clearSettingsCache()
  })

  it('names the deployment in the subject, preview, header and sign-off', async () => {
    const i18n = getEmailI18n('en')
    expect(magicLinkSubject(i18n)).toBe('Your Acme AI verification code')
    expect(waitlistJoinedSubject(i18n)).toBe("You're on the Acme AI waitlist!")

    const magic = await renderCopy(magicLink('en'))
    expect(magic).toContain('Sign in to Acme AI')
    expect(magic).toContain('alt="Acme AI"')
    expect(magic).not.toContain('Thunderbolt')

    const waitlist = await renderCopy(<WaitlistJoinedEmail i18n={i18n} />)
    expect(waitlist).toContain("You've been added to the Acme AI waitlist.")
    expect(waitlist).toContain('The Acme AI Team')
  })

  it('uses the branded light colors as hex and a PNG logo URL', async () => {
    process.env.BRANDING_JSON = JSON.stringify({
      appName: 'Acme AI',
      logo: { light: 'https://acme.test/mark.png' },
      cssVars: { light: { primary: 'oklch(0.5 0.2 260)', brand: '#d1006b' } },
    })
    clearSettingsCache()
    const html = await renderCopy(magicLink('en'))
    expect(html).toContain('src="https://acme.test/mark.png"')
    // React Email writes Tailwind colors as rgb(): the brand link is #d1006b.
    expect(html).toContain('color:rgb(209,0,107)')
    expect(html).not.toContain('oklch')
  })

  it('keeps the bundled email logo when the operator logo is SVG', async () => {
    process.env.BRANDING_JSON = JSON.stringify({ logo: { light: 'https://acme.test/mark.svg' } })
    clearSettingsCache()
    const html = await renderCopy(magicLink('en'))
    expect(html).toContain('/email-logo.png')
    expect(html).not.toContain('mark.svg')
  })

  it('keeps the name in translated copy', async () => {
    const html = await renderCopy(<WaitlistJoinedEmail i18n={getEmailI18n('en-XA')} />)
    expect(html).toContain('Acme AI')
  })
})
