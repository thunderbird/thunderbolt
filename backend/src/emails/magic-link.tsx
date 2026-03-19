import { Button, Section, Text } from '@react-email/components'
import { EmailLayout } from './email-layout'

type MagicLinkEmailProps = {
  code: string
  magicLinkUrl: string
}

export const MagicLinkEmail = ({ code, magicLinkUrl }: MagicLinkEmailProps) => (
  <EmailLayout preview={`Thunderbolt Verification Code: ${code}`}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-sm text-tb-text m-0 mb-6">Use the code below to sign in, or click the magic link.</Text>
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">{code}</Text>
      <Button
        href={magicLinkUrl}
        className="bg-tb-button text-white text-sm font-medium rounded-xl px-6 py-2.5 box-border"
      >
        Magic link
      </Button>
    </Section>
  </EmailLayout>
)

MagicLinkEmail.PreviewProps = {
  code: '882999',
  magicLinkUrl: 'https://thunderbolt.io/auth/verify?email=user@example.com&otp=882999',
} satisfies MagicLinkEmailProps

export default MagicLinkEmail
