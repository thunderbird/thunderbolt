/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type FormEvent, useState, useTransition } from 'react'

export type ContactSubmission = { status: 'success' } | { status: 'error'; message: string }

const failureMessage = 'We couldn’t confirm your message was sent. Please try again.'
const statusMessages: Record<number, string> = {
  422: 'Please check your details and enter a valid email address.',
  429: 'Too many requests. Please wait before trying again.',
  503: 'The contact form is temporarily unavailable. Please try again later.',
}

/** Submit only public form fields; success requires an explicit acknowledgement from the API. */
export const submitContactForm = async (fields: FormData, endpoint: string): Promise<ContactSubmission> => {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(Object.fromEntries(fields)),
    })
    if (!response.ok) return { status: 'error', message: statusMessages[response.status] ?? failureMessage }
    const result: unknown = await response.json()
    if (typeof result !== 'object' || result === null || !('success' in result) || result.success !== true) {
      return { status: 'error', message: failureMessage }
    }
    return { status: 'success' }
  } catch {
    return { status: 'error', message: failureMessage }
  }
}

/** Preserve the native form's fields on failure and report only confirmed submissions. */
export const useContactFormState = (endpoint: string) => {
  const [submission, setSubmission] = useState<ContactSubmission | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setSubmission(null)
    startTransition(async () => {
      setSubmission(await submitContactForm(fields, endpoint))
    })
  }

  return { submission, isPending, handleSubmit }
}
