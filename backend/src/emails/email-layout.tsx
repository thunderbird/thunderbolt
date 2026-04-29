/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Body,
  Container,
  Head,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
  pixelBasedPreset,
} from '@react-email/components'
import { emailFrom } from '@/lib/resend'
import { getSettings } from '@/config/settings'

/**
 * Email-safe color palette.
 * These are intentionally separate from the app's Tailwind v4 CSS theme
 * (src/index.css) because email clients don't support oklch colors or
 * CSS custom properties. Keep these hex values aligned with the app theme
 * manually when rebranding.
 */
const emailColors = {
  'tb-bg': '#f9fafb',
  'tb-text': '#101828',
  'tb-border': '#eaecf0',
  'tb-button': '#344054',
  'tb-link': '#3888d0',
}

type EmailLayoutProps = {
  preview: string
  children: React.ReactNode
}

export const EmailLayout = ({ preview, children }: EmailLayoutProps) => {
  const { appUrl } = getSettings()

  return (
    <Html lang="en">
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
          theme: {
            extend: {
              colors: emailColors,
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
                  src={`${appUrl}/email-logo.png`}
                  width="20"
                  height="20"
                  alt="Thunderbolt"
                  style={{ display: 'inline', verticalAlign: 'middle', width: '20px', height: '20px' }}
                />
                <Text className="inline align-middle text-xl font-medium text-tb-text tracking-tight m-0 ml-1">
                  Thunderbolt
                </Text>
              </Link>
            </Section>

            {children}

            <Section className="text-center mt-6">
              <Text className="text-xs text-tb-text m-0">
                Questions?{' '}
                <Link href={`mailto:${emailFrom}`} className="text-tb-link underline">
                  You can reply to this email
                </Link>
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}
