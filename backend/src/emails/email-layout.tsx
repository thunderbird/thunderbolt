/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Body, Container, Head, Html, Img, Link, Preview, Section, Tailwind, Text, pixelBasedPreset } from 'react-email'
import { emailFrom } from '@/lib/resend'
import { getSettings } from '@/config/settings'
import { defaultAppName, toHexColor, type BrandingModeTokens } from '@shared/branding'

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
  'tb-border': '#eaecf0',
  'tb-button': '#344054',
  'tb-link': '#3888d0',
}

// Emails render light, so only the light branding tokens apply.
const emailColorTokens: Record<keyof typeof defaultEmailColors, keyof BrandingModeTokens> = {
  'tb-bg': 'background',
  'tb-text': 'foreground',
  'tb-border': 'border',
  'tb-button': 'primary',
  'tb-link': 'brand',
}

/** The email palette: each light branding color converted to hex, else the default. */
export const emailColors = (light: BrandingModeTokens = {}): typeof defaultEmailColors =>
  Object.fromEntries(
    Object.entries(emailColorTokens).map(([name, token]) => {
      const value = light[token]
      return [name, (value && toHexColor(value)) ?? defaultEmailColors[name as keyof typeof defaultEmailColors]]
    }),
  ) as typeof defaultEmailColors

/**
 * The operator's light logo when email clients can show it — PNG or JPEG, which
 * most render, unlike SVG — else the bundled mark. Linked at its own URL: the
 * backend already downloads it from there, so it is public by construction.
 */
const emailLogoUrl = (logoUrl: string | undefined, appUrl: string): string =>
  logoUrl && /\.(?:png|jpe?g)$/i.test(new URL(logoUrl).pathname) ? logoUrl : `${appUrl}/email-logo.png`

/** The deployment's app name for email copy: the operator's branding, else Thunderbolt. */
export const emailAppName = (): string => getSettings().branding?.appName ?? defaultAppName

type EmailLayoutProps = {
  i18n: I18n
  preview: string
  children: import('react').ReactNode
}

export const EmailLayout = ({ i18n, preview, children }: EmailLayoutProps) => {
  const { appUrl, branding } = getSettings()
  const appName = emailAppName()

  return (
    <Html lang={i18n.locale}>
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
          theme: {
            extend: {
              colors: emailColors(branding?.cssVars?.light),
            },
          },
        }}
      >
        <Head />
        <Preview>{preview}</Preview>
        <Body className="bg-tb-bg font-sans py-10">
          <Container className="mx-auto max-w-[540px]">
            <Section className="text-center mb-6">
              <Link href={appUrl} className="no-underline">
                <Img
                  src={emailLogoUrl(branding?.logo?.light, appUrl)}
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
