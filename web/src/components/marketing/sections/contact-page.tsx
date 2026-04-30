/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { type ChangeEvent, type FormEvent, useReducer, useRef } from 'react'
import { FooterSection } from '../footer-section'
import { Header } from '../header'

const MAILCHIMP_URL =
  'https://thunderbird.us12.list-manage.com/subscribe/post?u=f8051cc8637cf3ff79661f382&id=61b3bbfdaa&f_id=00bfaae0f0'

type FormState = {
  firstName: string
  lastName: string
  title: string
  email: string
  help: string
  org: string
  companySize: string
  status: 'idle' | 'submitting' | 'success' | 'error'
  errorMessage: string
}

type FormField = 'firstName' | 'lastName' | 'title' | 'email' | 'help' | 'org' | 'companySize'

type FormAction =
  | { type: 'SET_FIELD'; field: FormField; value: string }
  | { type: 'SUBMITTING' }
  | { type: 'SUCCESS' }
  | { type: 'ERROR'; message: string }

const initialState: FormState = {
  firstName: '',
  lastName: '',
  title: '',
  email: '',
  help: '',
  org: '',
  companySize: '',
  status: 'idle',
  errorMessage: '',
}

const reducer = (state: FormState, action: FormAction): FormState => {
  if (action.type === 'SET_FIELD') return { ...state, [action.field]: action.value }
  if (action.type === 'SUBMITTING') return { ...state, status: 'submitting', errorMessage: '' }
  if (action.type === 'SUCCESS') return { ...state, status: 'success' }
  if (action.type === 'ERROR') return { ...state, status: 'error', errorMessage: action.message }
  return state
}

const useContactFormState = () => {
  const [state, dispatch] = useReducer(reducer, initialState)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const set =
    (field: FormField) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      dispatch({ type: 'SET_FIELD', field, value: e.target.value })

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    dispatch({ type: 'SUBMITTING' })

    const iframe = iframeRef.current
    if (!iframe || !formRef.current) {
      dispatch({ type: 'ERROR', message: 'Something went wrong. Please try again.' })
      return
    }

    if (!navigator.onLine) {
      dispatch({ type: 'ERROR', message: 'You appear to be offline. Please check your connection and try again.' })
      return
    }

    let settled = false

    const settle = (action: { type: 'SUCCESS' } | { type: 'ERROR'; message: string }) => {
      if (settled) return
      settled = true
      iframe.removeEventListener('load', onLoad)
      iframe.removeEventListener('error', onError)
      dispatch(action)
    }

    const onLoad = () => settle({ type: 'SUCCESS' })
    const onError = () => settle({ type: 'ERROR', message: 'Submission failed. Please try again.' })

    iframe.addEventListener('load', onLoad)
    iframe.addEventListener('error', onError)

    formRef.current.submit()

    // Fallback timeout — if neither load nor error fires in 10s, assume success
    // (cross-origin iframes may not fire events reliably)
    setTimeout(() => settle({ type: 'SUCCESS' }), 10000)
  }

  return { state, set, handleSubmit, iframeRef, formRef }
}

const inputClass =
  'w-full border border-[#d0d5dd] bg-white px-4 py-3 text-sm text-[#101828] placeholder:text-[#667085] outline-none focus:border-[#344054] focus:ring-1 focus:ring-[#344054]'

const labelClass = 'block text-sm font-medium text-[#344054] mb-1.5'

export const ContactPage = () => {
  const { state, set, handleSubmit, iframeRef, formRef } = useContactFormState()

  if (state.status === 'success') {
    return (
      <div className="min-h-screen bg-[#f9fafb]">
        <Header />
        <main className="flex min-h-screen flex-col items-center justify-center px-6 pt-[104px]">
          <img src="/enterprise/thunderbolt-logo.png" alt="Thunderbolt" className="size-12" />
          <h1 className="mt-4 text-[32px] font-medium leading-[1.2] tracking-[-0.96px] text-[#101828]">Thank you!</h1>
          <p className="mt-2 max-w-[400px] text-center text-base leading-6 text-[#667085]">
            We&rsquo;ve received your inquiry and will be in touch shortly.
          </p>
          <a
            href="/"
            className="mt-6 inline-flex h-[46px] w-[131px] items-center justify-center bg-[#344054] font-mono text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#344054]/90"
          >
            Go Back
          </a>
        </main>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f9fafb]">
      <Header />
      <main className="mx-auto w-full max-w-[560px] flex-1 px-6 pt-[144px] pb-24">
        <a href="/" className="mb-6 inline-flex items-center gap-1 text-sm text-[#667085] hover:text-[#344054]">
          &larr; Back
        </a>
        <h1 className="text-[32px] font-medium leading-[1.2] tracking-[-0.96px] text-[#101828] md:text-[40px]">
          Get in Touch
        </h1>
        <p className="mt-2 text-base leading-6 text-[#667085]">
          Tell us about your organization and how we can help.
        </p>

        {/* Hidden iframe target for form submission — no visible redirect */}
        <iframe ref={iframeRef} name="mc-hidden-iframe" className="hidden" aria-hidden="true" />

        <form
          ref={formRef}
          action={MAILCHIMP_URL}
          method="post"
          target="mc-hidden-iframe"
          onSubmit={handleSubmit}
          className="mt-8 flex flex-col gap-5"
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="mce-FNAME" className={labelClass}>First Name</label>
              <input type="text" name="FNAME" id="mce-FNAME" value={state.firstName} onChange={set('firstName')} className={inputClass} />
            </div>
            <div>
              <label htmlFor="mce-LNAME" className={labelClass}>Last Name</label>
              <input type="text" name="LNAME" id="mce-LNAME" value={state.lastName} onChange={set('lastName')} className={inputClass} />
            </div>
          </div>

          <div>
            <label htmlFor="mce-EMAIL" className={labelClass}>Email Address <span className="text-red-500">*</span></label>
            <input type="email" name="EMAIL" id="mce-EMAIL" value={state.email} onChange={set('email')} required className={inputClass} />
          </div>

          <div>
            <label htmlFor="mce-TITLE" className={labelClass}>Title</label>
            <input type="text" name="TITLE" id="mce-TITLE" value={state.title} onChange={set('title')} className={inputClass} />
          </div>

          <div>
            <label htmlFor="mce-ORG" className={labelClass}>Company / Organization</label>
            <input type="text" name="ORG" id="mce-ORG" value={state.org} onChange={set('org')} className={inputClass} />
          </div>

          <div>
            <label htmlFor="mce-MMERGE8" className={labelClass}>Company Size</label>
            <select
              name="MMERGE8"
              id="mce-MMERGE8"
              value={state.companySize}
              onChange={set('companySize')}
              className={inputClass}
            >
              <option value=""></option>
              <option value="1 to 50">1 to 50</option>
              <option value="51 to 200">51 to 200</option>
              <option value="201 to 1,000">201 to 1,000</option>
              <option value="1,001+">1,001+</option>
            </select>
          </div>

          <div>
            <label htmlFor="mce-HELP" className={labelClass}>How can we help?</label>
            <textarea name="HELP" id="mce-HELP" value={state.help} onChange={set('help')} rows={4} className={inputClass} />
          </div>

          {/* Mailchimp honeypot — must be present and empty */}
          <div className="absolute -left-[5000px]" aria-hidden="true">
            <input type="text" name="b_f8051cc8637cf3ff79661f382_61b3bbfdaa" tabIndex={-1} defaultValue="" />
          </div>

          {state.status === 'error' && (
            <p className="text-sm text-red-600">{state.errorMessage}</p>
          )}

          <button
            type="submit"
            disabled={state.status === 'submitting'}
            className="inline-flex h-[46px] w-full items-center justify-center bg-[#344054] font-mono text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#344054]/90 disabled:opacity-50"
          >
            {state.status === 'submitting' ? 'Submitting...' : 'Submit'}
          </button>
        </form>
      </main>
      <FooterSection className="pb-16" />
    </div>
  )
}
