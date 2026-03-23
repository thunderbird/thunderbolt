import {
  Body,
  Container,
  Head,
  Html,
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

/**
 * Inline SVG lightning bolt logo for email headers.
 * Based on the Zap icon used in the app (see src/components/app-logo.tsx).
 * Uses inline SVG because many email clients block external images by default.
 */
const ThunderboltLogo = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="#eab308"
    stroke="#eab308"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'inline', verticalAlign: 'middle' }}
  >
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  </svg>
)

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
                <ThunderboltLogo />
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
