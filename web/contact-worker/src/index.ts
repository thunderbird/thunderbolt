/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { contactBodySchema, type ContactSubmission } from './body'
import { readContactBody } from './request-body'

export type Env = {
  ALLOWED_ORIGINS: string
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  CONTACT_EMAIL_TO?: string
  IP_LIMITER: Pick<RateLimit, 'limit'>
  EMAIL_LIMITER: Pick<RateLimit, 'limit'>
}

type SendRequest = (url: string, init: RequestInit) => Promise<Response>
const emailSettings = z.object({
  RESEND_API_KEY: z.string().trim().min(1),
  EMAIL_FROM: z.email(),
  CONTACT_EMAIL_TO: z.email(),
})
const acceptedEmail = z.object({ id: z.string().min(1) })

/** Plain text keeps visitor content out of HTML and mail headers. */
const messageText = (submission: ContactSubmission) =>
  [
    `Email: ${submission.email}`,
    `Name: ${[submission.firstName, submission.lastName].filter(Boolean).join(' ') || 'Not provided'}`,
    `Organization: ${submission.org || 'Not provided'}`,
    `Job title: ${submission.title || 'Not provided'}`,
    `Company size: ${submission.companySize || 'Not provided'}`,
    '',
    'How can we help?',
    submission.help || 'Not provided',
  ].join('\n')

/** Handle only marketing inquiries; no app credentials, database, or backend connection. */
export const handleContact = async (
  request: Request,
  env: Env,
  sendRequest: SendRequest = fetch,
): Promise<Response> => {
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' })
  const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers })
  if (new URL(request.url).pathname !== '/api/contact') return json(404, { error: 'Not found.' })

  const origin = request.headers.get('Origin')
  const allowedOrigins = env.ALLOWED_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!origin || !allowedOrigins.includes(origin)) return json(403, { error: 'Origin not allowed.' })
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Content-Type')

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (request.method !== 'POST') {
    headers.set('Allow', 'POST, OPTIONS')
    return json(405, { error: 'Method not allowed.' })
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json(415, { error: 'Content-Type must be application/json.' })
  }

  const settings = emailSettings.safeParse(env)
  // Cloudflare supplies this header. Do not accept a client-selected X-Forwarded-For address.
  const ip = request.headers.get('CF-Connecting-IP')
  if (!settings.success || !ip) return json(503, { error: 'Contact form is currently unavailable.' })

  try {
    if (!(await env.IP_LIMITER.limit({ key: ip })).success) {
      headers.set('Retry-After', '60')
      return json(429, { error: 'Please wait before trying again.' })
    }
    const body = await readContactBody(request)
    if (!body.ok) return json(body.status, { error: body.error })
    const parsed = contactBodySchema.safeParse(body.value)
    if (!parsed.success) return json(422, { error: 'Please check your contact details.' })

    // This is a per-location burst limit, not a worldwide email quota.
    if (!(await env.EMAIL_LIMITER.limit({ key: 'contact' })).success) {
      headers.set('Retry-After', '60')
      return json(429, { error: 'Please wait before trying again.' })
    }
    const response = await sendRequest('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.data.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: settings.data.EMAIL_FROM,
        to: [settings.data.CONTACT_EMAIL_TO],
        reply_to: parsed.data.email,
        subject: 'Thunderbolt website inquiry',
        text: messageText(parsed.data),
      }),
    })
    if (!response.ok || !acceptedEmail.safeParse(await response.json()).success) {
      return json(502, { error: 'Your message could not be sent. Please try again later.' })
    }
    return json(200, { success: true })
  } catch {
    // Never log the submission, addresses, credentials, or upstream response body.
    console.error('[contact] Submission failed; check Worker availability and Resend delivery status.')
    return json(502, { error: 'Your message could not be sent. Please try again later.' })
  }
}

export default { fetch: (request, env) => handleContact(request, env) } satisfies ExportedHandler<Env>
