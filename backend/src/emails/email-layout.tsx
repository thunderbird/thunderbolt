/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Body, Container, Head, Html, Img, Link, Preview, Section, Tailwind, Text, pixelBasedPreset } from 'react-email'
import { emailFrom } from '@/lib/resend'
import { emailLogoUrl } from '@/branding/email-logo'
import { getSettings } from '@/config/settings'
import { resolveAppName, resolveBrandFill, toHexColor, type BrandingModeTokens } from '@shared/branding'

/**
 * Email-safe color palette.
 * These are intentionally separate from the app's Tailwind v4 CSS theme
 * (src/index.css) because email clients don't support oklch colors or
 * CSS custom properties. Keep these hex values aligned with the app theme
 * manually when rebranding; operator branding overrides them per deployment.
 */
const defaultEmailColors = {
  'tb-bg': '#f9fafb',
  'tb-text': '#101828',
  'tb-card': '#ffffff',
  'tb-card-text': '#101828',
  'tb-border': '#eaecf0',
  'tb-button': '#344054',
  'tb-button-text': '#ffffff',
  'tb-link': '#3888d0',
}

type EmailColors = typeof defaultEmailColors

const toHexOrUndefined = (value: string | undefined) => (value ? toHexColor(value) : undefined)

// A surface and the text on it, converted to hex as a pair: undefined unless
// both convert, so branded text never lands on a default surface or the reverse
// (a token that can't become hex, or a theme that sets only one of the two).
const brandedPair = (surface: string | undefined, text: string | undefined) => {
  const [surfaceHex, textHex] = [toHexOrUndefined(surface), toHexOrUndefined(text)]
  return surfaceHex && textHex ? { surface: surfaceHex, text: textHex } : undefined
}

/**
 * The email palette from the light branding tokens (emails render light),
 * converted to hex. The page, the card and the button each take their surface
 * and text as a pair, branded or default together; the button resolves as in
 * the app (`resolveBrandFill`). Links take the button color.
 *
 * @param light - The validated light-mode tokens.
 */
export const emailColorsFor = (light: BrandingModeTokens = {}): EmailColors => {
  const page = brandedPair(light.background, light.foreground)
  const card = brandedPair(light.card, light['card-foreground'])
  const brandFill = resolveBrandFill(light)
  const button = brandedPair(brandFill?.fill, brandFill?.foreground)
  return {
    'tb-bg': page?.surface ?? defaultEmailColors['tb-bg'],
    'tb-text': page?.text ?? defaultEmailColors['tb-text'],
    'tb-card': card?.surface ?? defaultEmailColors['tb-card'],
    'tb-card-text': card?.text ?? defaultEmailColors['tb-card-text'],
    'tb-border': toHexOrUndefined(light.border) ?? defaultEmailColors['tb-border'],
    'tb-button': button?.surface ?? defaultEmailColors['tb-button'],
    'tb-button-text': button?.text ?? defaultEmailColors['tb-button-text'],
    'tb-link': button?.surface ?? defaultEmailColors['tb-link'],
  }
}

/** The deployment's app name for email copy: the operator's branding, else Thunderbolt. */
export const emailAppName = (): string => resolveAppName(getSettings().branding)

type EmailLayoutProps = {
  i18n: I18n
  preview: string
  children: import('react').ReactNode
}

export const EmailLayout = ({ i18n, preview, children }: EmailLayoutProps) => {
  const settings = getSettings()
  const appName = emailAppName()

  return (
    <Html lang={i18n.locale}>
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
          theme: {
            extend: {
              colors: emailColorsFor(settings.branding?.cssVars?.light),
            },
          },
        }}
      >
        <Head />
        <Preview>{preview}</Preview>
        <Body className="bg-tb-bg font-sans py-10">
          <Container className="mx-auto max-w-[540px]">
            <Section className="text-center mb-6">
              <Link href={settings.appUrl} className="no-underline">
                <Img
                  src={emailLogoUrl(settings)}
                  width="20"
                  height="20"
                  alt={appName}
                  style={{ display: 'inline', verticalAlign: 'middle', width: '20px', height: '20px' }}
                />
                <Text className="inline align-middle text-xl font-medium text-tb-text tracking-tight m-0 ml-1">
                  {appName}
                </Text>
              </Link>
            </Section>

            {children}

            <Section className="text-center mt-6">
              <Text className="text-xs text-tb-text m-0">
                {i18n._({ id: 'Questions?' })}{' '}
                <Link href={`mailto:${emailFrom}`} className="text-tb-link underline">
                  {i18n._({ id: 'You can reply to this email' })}
                </Link>
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}
