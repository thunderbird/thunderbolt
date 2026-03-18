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

const baseURL = process.env.NODE_ENV === 'production' ? 'https://thunderbolt.io' : 'http://localhost:1420'

type EmailLayoutProps = {
  preview: string
  children: React.ReactNode
}

export const EmailLayout = ({ preview, children }: EmailLayoutProps) => (
  <Html lang="en">
    <Tailwind
      config={{
        presets: [pixelBasedPreset],
        theme: {
          extend: {
            colors: {
              'tb-bg': '#f9fafb',
              'tb-text': '#101828',
              'tb-border': '#eaecf0',
              'tb-button': '#344054',
              'tb-link': '#3888d0',
            },
          },
        },
      }}
    >
      <Head />
      <Preview>{preview}</Preview>
      <Body className="bg-tb-bg font-sans py-10">
        <Container className="mx-auto max-w-[540px]">
          <Section className="text-center mb-6">
            <Img src={`${baseURL}/logo.png`} alt="Thunderbolt" width="20" height="20" className="inline align-middle" />
            <Text className="inline align-middle text-xl font-medium text-tb-text tracking-tight m-0 ml-1">
              Thunderbolt
            </Text>
          </Section>

          {children}

          <Section className="text-center mt-6">
            <Text className="text-xs text-tb-text m-0">
              Questions?{' '}
              <Link href="mailto:hello@auth.thunderbolt.io" className="text-tb-link underline">
                You can reply to this email
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Tailwind>
  </Html>
)
