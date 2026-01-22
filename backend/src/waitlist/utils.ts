import { sendEmail, shouldSkipEmail } from '@/lib/resend'

type SendWaitlistEmailParams = {
  email: string
}

/**
 * Send email when user joins the waitlist
 * Uses a simple template saying "Thanks for signing up! We'll let you know when it's ready."
 */
export const sendJoinedWaitlistEmail = async ({ email }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending joined waitlist email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send joined waitlist email')
    return
  }

  const data = await sendEmail({ to: email, templateId: 'waitlist-joined' })

  console.info(`✅ Joined waitlist email sent successfully. ID: ${data?.id}`)
}

/**
 * Send waitlist reminder email for users already on the waitlist
 * Reminds them they're on the waitlist and we'll notify them when invited
 */
export const sendWaitlistReminderEmail = async ({ email }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist reminder email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send waitlist reminder email')
    return
  }

  const data = await sendEmail({ to: email, templateId: 'waitlist-reminder' })

  console.info(`✅ Waitlist reminder sent successfully. ID: ${data?.id}`)
}

/**
 * Send "not ready yet" email when a pending waitlist user tries to sign in
 * Lets them know they're still on the waitlist and we'll notify them when approved
 */
export const sendWaitlistNotReadyEmail = async ({ email }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist not-ready email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send waitlist not-ready email')
    return
  }

  const data = await sendEmail({ to: email, templateId: 'waitlist-not-ready' })

  console.info(`✅ Waitlist not-ready email sent successfully. ID: ${data?.id}`)
}
