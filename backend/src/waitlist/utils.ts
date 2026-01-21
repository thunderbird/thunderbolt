import { Resend } from 'resend'

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

type SendWaitlistConfirmationParams = {
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
}: SendWaitlistConfirmationParams): Promise<void> => {
  console.info(`📧 Sending waitlist confirmation to ${email}`)

  // Skip email in test/dev mode or if resend is not configured
  if (!resend || process.env.NODE_ENV === 'test') {
    if (isProduction && !resend) {
      console.error('❌ Cannot send email: RESEND_API_KEY is not configured')
      throw new Error('Email service not configured')
    }
    console.info(`📝 [DEV] Would send waitlist confirmation to: ${email}`)
    return
  }

  const { data, error } = await resend.emails.send({
    from: 'hello@auth.thunderbolt.io',
    to: email,
    subject: "You're on the Thunderbolt waitlist!",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h1 style="color: #f97316; font-size: 24px; margin-bottom: 24px;">Thanks for signing up!</h1>
        <p style="color: #374151; font-size: 16px; line-height: 1.6;">
          You've been added to the Thunderbolt waitlist. We're working hard to get you access as soon as possible.
        </p>
        <p style="color: #374151; font-size: 16px; line-height: 1.6;">
          We'll send you another email when it's your turn to join.
        </p>
        <p style="color: #6b7280; font-size: 14px; margin-top: 32px;">
          — The Thunderbolt Team
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('❌ Failed to send waitlist confirmation:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.info(`✅ Waitlist confirmation sent successfully. ID: ${data?.id}`)
}

type SendWaitlistReminderParams = {
  email: string
  isProduction: boolean
}

/**
 * Send waitlist reminder email for users already on the waitlist
 * Reminds them they're on the waitlist and we'll notify them when invited
 */
export const sendWaitlistReminderEmail = async ({ email, isProduction }: SendWaitlistReminderParams): Promise<void> => {
  console.info(`📧 Sending waitlist reminder to ${email}`)

  // Skip email in test/dev mode or if resend is not configured
  if (!resend || process.env.NODE_ENV === 'test') {
    if (isProduction && !resend) {
      console.error('❌ Cannot send email: RESEND_API_KEY is not configured')
      throw new Error('Email service not configured')
    }
    console.info(`📝 [DEV] Would send waitlist reminder to: ${email}`)
    return
  }

  const { data, error } = await resend.emails.send({
    from: 'hello@auth.thunderbolt.io',
    to: email,
    subject: "You're already on the Thunderbolt waitlist",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <h1 style="color: #f97316; font-size: 24px; margin-bottom: 24px;">You're already on the waitlist!</h1>
        <p style="color: #374151; font-size: 16px; line-height: 1.6;">
          Good news — you're already on the Thunderbolt waitlist. No need to sign up again!
        </p>
        <p style="color: #374151; font-size: 16px; line-height: 1.6;">
          We're working hard to get you access as soon as possible. We'll send you an email when it's your turn to join.
        </p>
        <p style="color: #6b7280; font-size: 14px; margin-top: 32px;">
          — The Thunderbolt Team
        </p>
      </div>
    `,
  })

  if (error) {
    console.error('❌ Failed to send waitlist reminder:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.info(`✅ Waitlist reminder sent successfully. ID: ${data?.id}`)
}
