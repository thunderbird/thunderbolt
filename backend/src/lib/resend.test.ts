/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import type { CreateEmailResponse } from 'resend'
import { EmailDeliveryError, emailFrom, sendEmail } from './resend'

const react = createElement('p', null, 'Hello')

/** A stand-in Resend client that answers every send with `response`. */
const createClient = (response: CreateEmailResponse) => {
  const send = mock(async (_payload: unknown) => response)
  return { client: { emails: { send } }, send }
}

describe('sendEmail', () => {
  it('sends from the default address and returns what the provider accepted', async () => {
    const { client, send } = createClient({ data: { id: 'email_1' }, error: null, headers: null })
    const accepted = await sendEmail({ to: 'user@example.org', subject: 'Sign in', react }, client)
    expect(accepted).toEqual({ id: 'email_1' })
    expect(send.mock.calls[0]?.[0]).toEqual({
      from: emailFrom,
      to: 'user@example.org',
      subject: 'Sign in',
      react,
      replyTo: undefined,
    })
  })

  it('passes a sender override and a reply-to address through', async () => {
    const { client, send } = createClient({ data: { id: 'email_2' }, error: null, headers: null })
    await sendEmail(
      { to: 'team@example.org', from: 'forms@example.org', replyTo: 'visitor@example.org', subject: 'Inquiry', react },
      client,
    )
    expect(send.mock.calls[0]?.[0]).toMatchObject({ from: 'forms@example.org', replyTo: 'visitor@example.org' })
  })

  it("throws the provider's reason, with its code and status as separate fields", async () => {
    const { client } = createClient({
      data: null,
      error: { name: 'validation_error', statusCode: 403, message: 'The example.org domain is not verified.' },
      headers: null,
    })
    const failure = await sendEmail({ to: 'user@example.org', subject: 'Sign in', react }, client).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(EmailDeliveryError)
    expect(failure).toMatchObject({
      message: 'Failed to send email: The example.org domain is not verified.',
      providerCode: 'validation_error',
      providerStatus: 403,
    })
  })

  it('throws when no provider is configured', async () => {
    await expect(sendEmail({ to: 'user@example.org', subject: 'Sign in', react }, null)).rejects.toThrow(
      'Email service not configured',
    )
  })
})
