/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactElement } from 'react'
import { render } from 'react-email'
import type { AppLocale } from '@shared/i18n/locales'
import { clearSettingsCache } from '@/config/settings'
import { stepUpCopy } from '@/lib/security-notifications'
import type { StepUpAction } from '@/lib/step-up-otp'
import { getEmailI18n } from './i18n'
import { emailLogoUrl } from '@/branding/email-logo'
import { emailColorsFor } from './email-layout'
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
    process.env.BRANDING = JSON.stringify({ appName: 'Acme AI' })
    clearSettingsCache()
  })

  afterEach(() => {
    delete process.env.BRANDING
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

  it('uses the branded light colors as hex, with readable button text', async () => {
    process.env.BRANDING = JSON.stringify({
      appName: 'Acme AI',
      cssVars: { light: { primary: 'oklch(0.5 0.2 260)', brand: '#facc15' } },
    })
    clearSettingsCache()
    const html = await renderCopy(magicLink('en'))
    // React Email writes Tailwind colors as rgb(): brand #facc15 fills the button and links,
    // and dark ink (#262120) reads on it where white would not.
    expect(html).toContain('background-color:rgb(250,204,21)')
    expect(html).toContain('color:rgb(38,33,32)')
    expect(html).not.toContain('oklch')
  })

  it("links the backend's copy of the operator logo, never the logo host", async () => {
    process.env.BRANDING = JSON.stringify({ logo: { light: 'https://acme.test/mark.png' } })
    clearSettingsCache()
    const html = await renderCopy(magicLink('en'))
    expect(html).toContain('/v1/config/branding/email-logo"')
    expect(html).not.toContain('acme.test/mark.png')
  })

  it('links the bundled mark when the operator sets no logo', async () => {
    const html = await renderCopy(magicLink('en'))
    expect(html).toContain('/email-logo.png')
  })

  it('keeps the name in translated copy', async () => {
    // The header shows the name in every locale; the sign-off proves the translation kept the placeholder.
    const html = await renderCopy(<WaitlistJoinedEmail i18n={getEmailI18n('de')} />)
    expect(html).toContain('Das Acme AI-Team')
  })
})

describe('emailColorsFor', () => {
  it('keeps the default palette without branding', () => {
    expect(emailColorsFor()).toEqual({
      'tb-bg': '#f9fafb',
      'tb-text': '#101828',
      'tb-card': '#ffffff',
      'tb-card-text': '#101828',
      'tb-border': '#eaecf0',
      'tb-button': '#344054',
      'tb-button-text': '#ffffff',
      'tb-link': '#3888d0',
    })
  })

  it('fills the button from primary when there is no brand, with its own foreground', () => {
    const colors = emailColorsFor({ primary: '#111111', 'primary-foreground': '#eeeeee' })
    expect(colors['tb-button']).toBe('#111111')
    expect(colors['tb-button-text']).toBe('#eeeeee')
    expect(colors['tb-link']).toBe('#111111')
  })

  it('prefers brand and brand-foreground, as the app does, even when only brand-foreground is set', () => {
    expect(emailColorsFor({ brand: '#d1006b', 'brand-foreground': '#ffffff' })['tb-button-text']).toBe('#ffffff')
    expect(emailColorsFor({ primary: '#111111', 'brand-foreground': '#abcdef' })['tb-button-text']).toBe('#abcdef')
  })

  it('keeps the button and its text as a pair, falling back together', () => {
    // A `none` channel can't become hex, so the explicit dark text must not land on the default dark fill.
    expect(emailColorsFor({ brand: 'oklch(0.5 none 120)', 'brand-foreground': '#111111' })).toMatchObject({
      'tb-button': '#344054',
      'tb-button-text': '#ffffff',
      'tb-link': '#3888d0',
    })
  })

  it('keeps the page colors as a pair when one cannot be evaluated', () => {
    const colors = emailColorsFor({ background: 'rgb(0 0 0)', foreground: 'oklch(0.5 0.1 none)', border: '#000' })
    expect(colors['tb-bg']).toBe('#f9fafb')
    expect(colors['tb-text']).toBe('#101828')
    expect(colors['tb-border']).toBe('#000000')
  })

  it('takes the card from card and card-foreground, so a dark page never puts light text on a white card', () => {
    const darkPage = {
      background: '#000000',
      foreground: '#ffffff',
      primary: '#ffffff',
      'primary-foreground': '#000000',
    }
    expect(emailColorsFor(darkPage)).toMatchObject({
      'tb-bg': '#000000',
      'tb-text': '#ffffff',
      'tb-card': '#ffffff',
      'tb-card-text': '#101828',
      'tb-button': '#ffffff',
      'tb-button-text': '#000000',
    })
    expect(emailColorsFor({ ...darkPage, card: '#111111', 'card-foreground': '#fafafa' })).toMatchObject({
      'tb-card': '#111111',
      'tb-card-text': '#fafafa',
    })
  })
})

describe('emailLogoUrl', () => {
  const urls = { appUrl: 'https://app.acme.test', betterAuthUrl: 'https://api.acme.test/auth' }

  it("names the API's email-logo route at the API's origin when the operator sets a logo", () => {
    expect(emailLogoUrl({ ...urls, branding: { logo: { light: 'https://cdn.test/l.png' } } })).toBe(
      'https://api.acme.test/v1/config/branding/email-logo',
    )
  })

  it('names the bundled mark otherwise', () => {
    expect(emailLogoUrl({ ...urls, branding: undefined })).toBe('https://app.acme.test/email-logo.png')
  })
})
