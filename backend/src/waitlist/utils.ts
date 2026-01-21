import { resend, shouldSkipEmail } from '@/lib/resend'

type SendWaitlistEmailParams = {
  email: string
  isProduction: boolean
}

/**
 * Send waitlist confirmation email
 * Uses a simple template saying "Thanks for signing up! We'll let you know when it's ready."
 */
export const sendWaitlistConfirmationEmail = async ({
  email,
  isProduction,
}: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist confirmation email')

  if (shouldSkipEmail(isProduction)) {
    console.info('📝 [DEV] Would send waitlist confirmation email')
    return
  }

  const { data, error } = await resend!.emails.send({
    from: 'hello@auth.thunderbolt.io',
    to: email,
    template: {
      id: 'waitlist-confirmation',
      variables: {},
    },
  })

  if (error) {
    console.error('❌ Failed to send waitlist confirmation:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.info(`✅ Waitlist confirmation sent successfully. ID: ${data?.id}`)
}

/**
 * Send waitlist reminder email for users already on the waitlist
 * Reminds them they're on the waitlist and we'll notify them when invited
 */
export const sendWaitlistReminderEmail = async ({ email, isProduction }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist reminder email')

  if (shouldSkipEmail(isProduction)) {
    console.info('📝 [DEV] Would send waitlist reminder email')
    return
  }

  const { data, error } = await resend!.emails.send({
    from: 'hello@auth.thunderbolt.io',
    to: email,
    template: {
      id: 'waitlist-reminder',
      variables: {},
    },
  })

  if (error) {
    console.error('❌ Failed to send waitlist reminder:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.info(`✅ Waitlist reminder sent successfully. ID: ${data?.id}`)
}

/**
 * Send "not ready yet" email when a pending waitlist user tries to sign in
 * Lets them know they're still on the waitlist and we'll notify them when approved
 */
export const sendWaitlistNotReadyEmail = async ({ email, isProduction }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist not-ready email')

  if (shouldSkipEmail(isProduction)) {
    console.info('📝 [DEV] Would send waitlist not-ready email')
    return
  }

  const { data, error } = await resend!.emails.send({
    from: 'hello@auth.thunderbolt.io',
    to: email,
    template: {
      id: 'waitlist-not-ready',
      variables: {},
    },
  })

  if (error) {
    console.error('❌ Failed to send waitlist not-ready email:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.info(`✅ Waitlist not-ready email sent successfully. ID: ${data?.id}`)
}
