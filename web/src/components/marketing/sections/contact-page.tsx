/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SparkFooter } from '../spark/spark-footer'
import { SparkHeader } from '../spark/spark-header'
import { useContactFormState } from './use-contact-form-state'

const contactEndpoint = import.meta.env.PUBLIC_CONTACT_ENDPOINT ?? ''

const inputClass =
  'w-full rounded-lg border border-border-strong bg-card px-4 py-3 text-base text-foreground placeholder:text-muted-foreground outline-none focus:border-brand focus:ring-1 focus:ring-brand'

const labelClass = 'block text-sm font-medium text-secondary-foreground mb-1.5'

export const ContactPage = ({
  endpoint = contactEndpoint,
}: {
  endpoint?: string
}) => {
  const { submission, isPending, handleSubmit } = useContactFormState(endpoint)

  if (submission?.status === 'success') {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <SparkHeader currentPage="Contact" />
        <main className="flex flex-1 flex-col items-center justify-center px-6 py-24">
          <img src="/enterprise/thunderbolt-logo.png" alt="Thunderbolt" className="size-12" />
          <h1
            tabIndex={-1}
            ref={(heading) => heading?.focus()}
            className="mt-4 font-sans text-[32px] font-medium leading-[1.2] tracking-[-0.96px] text-foreground"
          >
            Thank you!
          </h1>
          <p className="mt-2 max-w-[400px] text-center text-base leading-6 text-muted-foreground">
            Your message has been sent to the Thunderbolt team.
          </p>
          <a href="/" className="button-primary mt-6">
            Go Back
          </a>
        </main>
        <SparkFooter />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SparkHeader currentPage="Contact" />
      <main className="mx-auto w-full max-w-[640px] flex-1 px-6 pt-16 pb-24">
        <a
          href="/"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-secondary-foreground"
        >
          &larr; Back
        </a>
        <h1 className="font-sans text-[32px] font-medium leading-[1.2] tracking-[-0.96px] text-foreground md:text-[40px]">
          Get in Touch
        </h1>
        <p className="mt-2 text-base leading-6 text-muted-foreground">
          Tell us about your organization and how we can help.
        </p>

        <form
          onSubmit={handleSubmit}
          aria-busy={isPending}
          className="mt-8 flex flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-soft sm:p-8"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="contact-firstName" className={labelClass}>
                First Name
              </label>
              <input
                type="text"
                name="firstName"
                maxLength={150}
                autoComplete="given-name"
                id="contact-firstName"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="contact-lastName" className={labelClass}>
                Last Name
              </label>
              <input
                type="text"
                name="lastName"
                maxLength={150}
                autoComplete="family-name"
                id="contact-lastName"
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label htmlFor="contact-email" className={labelClass}>
              Email Address <span className="text-brand">*</span>
            </label>
            <input
              type="email"
              name="email"
              maxLength={254}
              autoComplete="email"
              id="contact-email"
              required
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="contact-title" className={labelClass}>
              Title
            </label>
            <input
              type="text"
              name="title"
              maxLength={150}
              autoComplete="organization-title"
              id="contact-title"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="contact-org" className={labelClass}>
              Company / Organization
            </label>
            <input
              type="text"
              name="org"
              maxLength={200}
              autoComplete="organization"
              id="contact-org"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="contact-companySize" className={labelClass}>
              Company Size
            </label>
            <select name="companySize" id="contact-companySize" className={inputClass}>
              <option value=""></option>
              <option value="1 to 50">1 to 50</option>
              <option value="51 to 200">51 to 200</option>
              <option value="201 to 1,000">201 to 1,000</option>
              <option value="1,001+">1,001+</option>
            </select>
          </div>

          <div>
            <label htmlFor="contact-help" className={labelClass}>
              How can we help?
            </label>
            <textarea name="help" maxLength={5000} id="contact-help" rows={4} className={inputClass} />
          </div>

          {/* Bots fill this field; visitors and assistive technology skip it. */}
          <div className="absolute -left-[5000px]" aria-hidden="true">
            <input type="text" name="website" autoComplete="off" tabIndex={-1} defaultValue="" />
          </div>

          {submission?.status === 'error' && (
            <p role="alert" className="text-sm text-brand">
              {submission.message}
            </p>
          )}

          <button type="submit" disabled={isPending} className="button-primary w-full disabled:opacity-50">
            {isPending ? 'Sending…' : 'Send message'}
          </button>
        </form>
      </main>
      <SparkFooter />
    </div>
  )
}
