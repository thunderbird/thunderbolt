import { type FormEvent, useReducer } from 'react'

/** Mailchimp JSONP endpoint — swap /subscribe/post for /subscribe/post-json to get a JSONP response instead of a redirect. */
const MAILCHIMP_JSONP_URL =
  'https://thunderbird.us12.list-manage.com/subscribe/post-json?u=f8051cc8637cf3ff79661f382&id=61b3bbfdaa&f_id=00bfaae0f0'

type FormState = {
  firstName: string
  lastName: string
  title: string
  email: string
  help: string
  org: string
  status: 'idle' | 'submitting' | 'success' | 'error'
  errorMessage: string
}

type FormAction =
  | { type: 'SET_FIELD'; field: keyof FormState; value: string }
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

/** Submit to Mailchimp via JSONP (no CORS issues, no redirect). */
const submitToMailchimp = (params: URLSearchParams): Promise<{ result: string; msg: string }> =>
  new Promise((resolve, reject) => {
    const callbackName = `mc_callback_${Date.now()}`
    const script = document.createElement('script')

    // Cleanup after response or timeout
    const cleanup = () => {
      delete (window as Record<string, unknown>)[callbackName]
      script.remove()
    }

    ;(window as Record<string, unknown>)[callbackName] = (data: { result: string; msg: string }) => {
      cleanup()
      resolve(data)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Request timed out'))
    }, 10000)

    script.src = `${MAILCHIMP_JSONP_URL}&c=${callbackName}&${params.toString()}`
    script.onerror = () => {
      clearTimeout(timeout)
      cleanup()
      reject(new Error('Failed to submit'))
    }

    document.body.appendChild(script)

    // Clear timeout on success (callback will resolve before timeout)
    script.onload = () => clearTimeout(timeout)
  })

const inputClass =
  'w-full border border-[#d0d5dd] bg-white px-4 py-3 text-sm text-[#101828] placeholder:text-[#667085] outline-none focus:border-[#344054] focus:ring-1 focus:ring-[#344054]'

const labelClass = 'block text-sm font-medium text-[#344054] mb-1.5'

const Header = () => (
  <header className="fixed inset-x-0 top-0 z-50 h-[104px] bg-white/20 backdrop-blur-[32px]">
    <div className="mx-auto flex h-full max-w-[1440px] items-center justify-between px-6 lg:px-[160px]">
      <a href="/" className="flex items-center gap-[7px]">
        <img src="/enterprise/thunderbolt-logo.svg" alt="Thunderbolt" className="size-[23px]" />
        <span className="text-xl font-medium leading-7 tracking-[-0.4px] text-[#101828]">Thunderbolt</span>
      </a>
    </div>
  </header>
)

const FooterSection = () => (
  <footer className="pb-16">
    <div className="mx-auto max-w-[1120px] px-6 lg:px-0">
      <div className="flex items-center justify-center gap-2">
        <img src="/enterprise/thunderbolt-logo.svg" alt="Thunderbolt" className="size-[34px]" />
        <span className="text-xl font-medium tracking-tight text-[#101828]">Thunderbolt</span>
      </div>
      <div className="mx-auto mt-6 h-px max-w-[1118px] bg-[#eaecf0]" />
      <div className="mt-6 flex flex-col items-center justify-center gap-4 text-center md:flex-row md:gap-[60px]">
        <img src="/enterprise/mozilla-logo.svg" alt="Mozilla" className="h-6 w-auto" />
        <p className="max-w-[638px] text-xs leading-4 text-[#667085]">
          Thunderbolt is part of{' '}
          <a href="https://blog.thunderbird.net/2020/01/thunderbirds-new-home/" className="border-b border-[#667085]/40" target="_blank" rel="noopener noreferrer">
            MZLA Technologies Corporation
          </a>
          , a wholly owned subsidiary of Mozilla Foundation. Portions of this content are &copy;1998&ndash;2026 by individual contributors. Content available under a{' '}
          <a href="https://www.mozilla.org/foundation/licensing/website-content/" className="border-b border-[#667085]/40" target="_blank" rel="noopener noreferrer">
            Creative Commons license
          </a>
          .
        </p>
      </div>
    </div>
  </footer>
)

export const ContactPage = () => {
  const [state, dispatch] = useReducer(reducer, initialState)

  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    dispatch({ type: 'SET_FIELD', field, value: e.target.value })

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    dispatch({ type: 'SUBMITTING' })

    const params = new URLSearchParams({
      FNAME: state.firstName,
      LNAME: state.lastName,
      EMAIL: state.email,
      TITLE: state.title,
      ORG: state.org,
      HELP: state.help,
    })

    try {
      const data = await submitToMailchimp(params)
      if (data.result === 'success') {
        dispatch({ type: 'SUCCESS' })
      } else {
        // Mailchimp returns HTML in error messages — strip tags
        const cleanMsg = data.msg.replace(/<[^>]*>/g, '')
        dispatch({ type: 'ERROR', message: cleanMsg })
      }
    } catch {
      dispatch({ type: 'ERROR', message: 'Something went wrong. Please try again.' })
    }
  }

  if (state.status === 'success') {
    return (
      <div className="min-h-screen bg-[#f9fafb]">
        <Header />
        <main className="flex min-h-screen flex-col items-center justify-center px-6 pt-[104px]">
          <img src="/enterprise/thunderbolt-logo.svg" alt="Thunderbolt" className="size-12" />
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
    <div className="min-h-screen bg-[#f9fafb]">
      <Header />
      <main className="mx-auto max-w-[560px] px-6 pt-[144px] pb-24">
        <h1 className="text-[32px] font-medium leading-[1.2] tracking-[-0.96px] text-[#101828] md:text-[40px]">
          Get Started
        </h1>
        <p className="mt-2 text-base leading-6 text-[#667085]">
          Tell us about your organization and how we can help.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="mce-FNAME" className={labelClass}>First Name</label>
              <input type="text" id="mce-FNAME" value={state.firstName} onChange={set('firstName')} className={inputClass} />
            </div>
            <div>
              <label htmlFor="mce-LNAME" className={labelClass}>Last Name</label>
              <input type="text" id="mce-LNAME" value={state.lastName} onChange={set('lastName')} className={inputClass} />
            </div>
          </div>

          <div>
            <label htmlFor="mce-EMAIL" className={labelClass}>Email Address <span className="text-red-500">*</span></label>
            <input type="email" id="mce-EMAIL" value={state.email} onChange={set('email')} required className={inputClass} />
          </div>

          <div>
            <label htmlFor="mce-TITLE" className={labelClass}>Title</label>
            <input type="text" id="mce-TITLE" value={state.title} onChange={set('title')} className={inputClass} />
          </div>

          <div>
            <label htmlFor="mce-ORG" className={labelClass}>Company / Organization</label>
            <input type="text" id="mce-ORG" value={state.org} onChange={set('org')} className={inputClass} />
          </div>

          <div>
            <label htmlFor="mce-HELP" className={labelClass}>How can we help?</label>
            <textarea id="mce-HELP" value={state.help} onChange={set('help')} rows={4} className={inputClass} />
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
      <FooterSection />
    </div>
  )
}
