import { Button, Section, Text } from '@react-email/components'
import { EmailLayout } from './email-layout'

type WaitlistApprovedEmailProps = {
  code: string
  magicLinkUrl: string
}

export const WaitlistApprovedEmail = ({ code, magicLinkUrl }: WaitlistApprovedEmailProps) => (
  <EmailLayout preview="You're approved!">
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">You're approved!</Text>
      <Text className="text-sm text-tb-text m-0 mb-6">
        Good news — you've been granted early access to Thunderbolt! Use the code below to sign in, or click the magic
        link.
      </Text>
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
