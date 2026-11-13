/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ContactPage } from './contact-page'
import { submitContactForm } from './use-contact-form-state'

let request: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>

beforeEach(() => {
  request = spyOn(globalThis, 'fetch')
})

afterEach(() => request.mockRestore())

/** Public inputs mirror the normal browser form; no credentials are submitted. */
const fields = () => {
  const form = new FormData()
  form.set('email', 'person@example.org')
  form.set('help', 'We would like to self-host Thunderbolt.')
  form.set('website', '')
  return form
}

test('posts public fields as JSON without credentials and requires confirmed API acceptance', async () => {
  request.mockResolvedValue(Response.json({ success: true }))
  expect(await submitContactForm(fields(), 'https://contact.example.com/api/contact')).toEqual({ status: 'success' })
  const [endpoint, options] = request.mock.calls[0]
  expect(endpoint).toBe('https://contact.example.com/api/contact')
  expect(options?.credentials).toBe('omit')
  expect(options?.method).toBe('POST')
  expect(options?.headers).toEqual({ 'Content-Type': 'application/json' })
  expect(JSON.parse(options?.body as string)).toEqual({
    email: 'person@example.org',
    help: 'We would like to self-host Thunderbolt.',
    website: '',
  })
})

test.each([
  [422, 'Please check your details'],
  [429, 'Too many requests'],
  [503, 'temporarily unavailable'],
  [502, 'couldn’t confirm'],
  [500, 'couldn’t confirm'],
] as const)('reports HTTP %s honestly without exposing server diagnostics', async (status, message) => {
  request.mockResolvedValue(new Response('Private upstream error details', { status }))
  const result = await submitContactForm(fields(), 'https://contact.example.com/api/contact')
  expect(result.status).toBe('error')
  if (result.status === 'error') {
    expect(result.message).toContain(message)
    expect(result.message).not.toContain('Private upstream')
  }
})

test.each([null, {}, { success: false }, { success: 'true' }, 'success'])(
  'rejects unconfirmed success: %j',
  async (body) => {
    request.mockResolvedValue(Response.json(body))
    expect((await submitContactForm(fields(), 'https://contact.example.com/api/contact')).status).toBe('error')
  },
)

test('a static-host HTML fallback does not become a false success', async () => {
  request.mockResolvedValue(new Response('<html>Not found</html>'))
  expect((await submitContactForm(fields(), 'https://contact.example.com/api/contact')).status).toBe('error')
})

test('network failure returns an actionable error instead of a false acknowledgement', async () => {
  request.mockRejectedValue(new TypeError('network unavailable'))
  expect((await submitContactForm(fields(), 'https://contact.example.com/api/contact')).status).toBe('error')
})

test.each(['http', 'timeout'] as const)(
  'the form preserves fields after %s failure and focuses the confirmed success after retry',
  async (failure) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const controller = new AbortController()
    const timeout = spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => new AbortController().signal)
      .mockReturnValueOnce(controller.signal)
    let resolveResponse!: (response: Response) => void
    request.mockReturnValue(
      new Promise<Response>((resolve, reject) => {
        resolveResponse = resolve
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      }),
    )
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<ContactPage endpoint="https://contact.example.com/api/contact" />))
      const form = container.querySelector('form')!
      container.querySelector<HTMLInputElement>('[name=email]')!.value = 'person@example.org'
      container.querySelector<HTMLTextAreaElement>('[name=help]')!.value = 'Keep this message if sending fails.'
      const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await act(async () => {
        submit()
      })
      expect(container.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true)
      expect(timeout).toHaveBeenCalledWith(15_000)
      expect(request.mock.calls[0][1]?.signal).toBe(controller.signal)
      await act(async () => {
        if (failure === 'timeout') controller.abort(new DOMException('Timed out', 'TimeoutError'))
        else resolveResponse(new Response('', { status: 502 }))
      })
      expect(container.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(false)
      expect(container.querySelector('[role=alert]')!.textContent).toContain('couldn’t confirm')
      expect(container.querySelector('textarea')!.value).toBe('Keep this message if sending fails.')
      request.mockResolvedValue(Response.json({ success: true }))
      await act(async () => {
        submit()
      })
      expect(container.querySelector('h1')!.textContent).toBe('Thank you!')
      expect(document.activeElement).toBe(container.querySelector('h1'))
      expect(container.querySelector('form')).toBeNull()
      expect(JSON.parse(request.mock.calls[1][1]?.body as string)).toEqual({
        email: 'person@example.org',
        firstName: '',
        lastName: '',
        title: '',
        org: '',
        companySize: '',
        help: 'Keep this message if sending fails.',
        website: '',
      })
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      timeout.mockRestore()
      await act(async () => root.unmount())
      container.remove()
    }
  },
)

test.each(['', '  '])('unconfigured builds never send inquiries to the website or app backend', async (endpoint) => {
  expect(await submitContactForm(fields(), endpoint)).toEqual({
    status: 'error',
    message: 'The contact form is temporarily unavailable. Please try again later.',
  })
  expect(request).not.toHaveBeenCalled()
})
