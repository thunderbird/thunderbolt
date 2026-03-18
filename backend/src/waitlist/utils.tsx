import { sendEmail, shouldSkipEmail } from '@/lib/resend'
import { WaitlistJoinedEmail } from '@/emails/waitlist-joined'
import { WaitlistReminderEmail } from '@/emails/waitlist-reminder'
import { WaitlistNotReadyEmail } from '@/emails/waitlist-not-ready'

type SendWaitlistEmailParams = {
  email: string
}

/**
 * Send email when user joins the waitlist.
 */
export const sendWaitlistJoinedEmail = async ({ email }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending joined waitlist email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send joined waitlist email')
    return
  }

  const data = await sendEmail({
    to: email,
    subject: "You're on the Thunderbolt waitlist!",
    react: <WaitlistJoinedEmail />,
  })
  console.info(`✅ Joined waitlist email sent successfully. ID: ${data?.id}`)
}

/**
 * Send waitlist reminder email for users already on the waitlist.
 */
export const sendWaitlistReminderEmail = async ({ email }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist reminder email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send waitlist reminder email')
    return
  }

  const data = await sendEmail({
    to: email,
    subject: "You're already on the waitlist!",
    react: <WaitlistReminderEmail />,
  })
  console.info(`✅ Waitlist reminder sent successfully. ID: ${data?.id}`)
}

/**
 * Send "not ready yet" email when a pending waitlist user tries to sign in.
 */
export const sendWaitlistNotReadyEmail = async ({ email }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist not-ready email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send waitlist not-ready email')
    return
  }

  const data = await sendEmail({
    to: email,
    subject: "You're on the Thunderbolt waitlist!",
    react: <WaitlistNotReadyEmail />,
  })
  console.info(`✅ Waitlist not-ready email sent successfully. ID: ${data?.id}`)
}
