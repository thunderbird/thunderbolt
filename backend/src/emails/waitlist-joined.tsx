import { Section, Text } from '@react-email/components'
import { EmailLayout } from './email-layout'

export const WaitlistJoinedEmail = () => (
  <EmailLayout preview="You're on the Thunderbolt waitlist!">
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">Thanks for signing up!</Text>
      <Text className="text-sm text-tb-text m-0 mb-6">
        You've been added to the Thunderbolt waitlist. We're working hard to get you access as soon as possible. We'll
        send you another email when it's your turn to join.
      </Text>
      <Text className="text-sm text-tb-text m-0">The Thunderbolt Team</Text>
    </Section>
  </EmailLayout>
)

export default WaitlistJoinedEmail
