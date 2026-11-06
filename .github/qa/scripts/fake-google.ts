/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Fake Google for the QA stack: the OAuth account chooser, the token endpoint, userinfo, and exactly the Gmail and
// Calendar endpoints the app's Google tools call, all on one origin (their real paths never collide). The account
// picked on the chooser is the scenario switch. Fixture times are UTC and computed per request.

import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

export const fakeGoogleClientId = 'fake-google-client-id'
export const fakeGoogleClientSecret = 'fake-google-client-secret'

const scopeUrl = (name: string) => `https://www.googleapis.com/auth/${name}`
const gmailRead = scopeUrl('gmail.readonly')
const gmailCompose = scopeUrl('gmail.compose')
const calendarRead = scopeUrl('calendar.readonly')

type Account = { email: string; name: string }

// The local part of a failure account names its scenario: `revoked@` cannot refresh, `big@` has 1,200 emails.
const accounts: Account[] = [
  { email: 'jonas@gmail.test', name: 'Jonas Weber' },
  { email: 'camille@gmail.test', name: 'Camille Laurent' },
  ...['expired', 'revoked', 'no-calendar-api', 'no-calendar-scope', 'empty', 'big'].map((name) => ({
    email: `${name}@gmail.test`,
    name,
  })),
]
const scenario = (account: Account) => account.email.split('@')[0]

const hour = 3_600_000
const day = 24 * hour

type FakeEvent = { summary: string; start: number; end: number; allDay?: boolean }
type FakeMessage = { id: string; from: string; subject: string; body: string; date: number; labels: string[] }

const event = (summary: string, start: number, hours: number, allDay?: boolean): FakeEvent => ({
  summary,
  start,
  end: start + hours * hour,
  allDay,
})
const noEvents: FakeEvent[] = []

/**
 * The account's calendars by id; the primary one is keyed by the account's email, as in Google. Everyone but Camille,
 * `empty@` and `big@` gets Jonas's week, so each failure account can be tried on the calendar case.
 * ponytail: on a Thursday, "the next Thursday" is 7 days away and the tool's default 7-day window cuts it.
 */
const calendarsOf = (account: Account, now: number) => {
  const today = now - (now % day)
  if (['camille', 'empty'].includes(scenario(account))) return new Map([[account.email, noEvents]])
  if (scenario(account) === 'big') {
    // 14 half-hour meetings a day from 08:00, starting tomorrow.
    const start = (i: number) => today + (1 + Math.floor(i / 14)) * day + (8 + (i % 14) / 2) * hour
    return new Map([[account.email, Array.from({ length: 80 }, (_, i) => event(`Meeting ${i + 1}`, start(i), 0.5))]])
  }
  const nextWeekday = (weekday: number) => today + ((weekday - new Date(now).getUTCDay() + 7) % 7 || 7) * day
  const thursday = nextWeekday(4)
  const primary = [
    event('Client workshop (Acme)', thursday + 9 * hour, 2),
    event('Lunch with Ana', thursday + 12 * hour, 1),
    event('Proposal writing', thursday + 13 * hour, 2),
    event('Quarterly planning', thursday + 16 * hour, 2),
    event('Conference - Lisbon', thursday + day, 24, true),
  ]
  const work = [event('Design review', thursday + 15 * hour, 1), event('1:1 with Marco', nextWeekday(2) + 14 * hour, 1)]
  return new Map([
    [account.email, primary],
    ['jonas@northwind.test', work],
  ])
}

const rita = 'Rita Okafor <rita.okafor@northstar-ventures.test>'
const paul = 'Paul Meyer <paul.meyer@brightloop.test>'
const triage = [
  {
    hoursAgo: 2,
    from: rita,
    subject: 'Term sheet: signature needed today by 17:00 UTC',
    body: "Hi Camille,\n\nThe final term sheet is ready to sign. We need your signature today by 17:00 UTC. After that our partners' approval lapses and the deal goes back to committee.\n\nRita Okafor\nNorthstar Ventures",
    labels: ['UNREAD'],
  },
  {
    hoursAgo: 4,
    from: paul,
    subject: 'Prod database at 91% disk',
    body: 'Camille,\n\nThe production database is at 91% disk. I want to double the volume this week, about $400 more per month. I need your OK by tomorrow so we can do it before it fills up.\n\nPaul\nCTO, Brightloop',
    labels: ['UNREAD', 'IMPORTANT'],
  },
  {
    hoursAgo: 7,
    from: 'Jana Novak <jana.novak@kestrel.test>',
    subject: "Can we move Thursday's demo?",
    body: "Hi Camille,\n\nSomething came up on our side. Could we move Thursday's demo to Friday at the same time?\n\nThanks,\nJana",
    labels: ['UNREAD'],
  },
  {
    hoursAgo: 9,
    from: 'Acme Tools <deals@acmetools.test>',
    subject: 'ACTION REQUIRED: your 40% discount expires tonight',
    body: 'Last chance! Upgrade to Acme Tools Pro with 40% off. The offer ends tonight at midnight.',
    labels: ['UNREAD', 'IMPORTANT', 'CATEGORY_PROMOTIONS'],
  },
  {
    hoursAgo: 20,
    from: 'The Founder Weekly <newsletter@founderweekly.test>',
    subject: 'Founder Weekly #212: pricing experiments that worked',
    body: 'This week: five pricing experiments from seed-stage founders, and what they learned.',
    labels: ['UNREAD'],
  },
  {
    hoursAgo: 26,
    from: 'People Team <people@brightloop.test>',
    subject: "Next year's holiday calendar",
    body: "Hi all,\n\nNext year's company holiday calendar is now in the handbook. Tell us by the end of the month if a date clashes with your plans.\n\nPeople Team",
    labels: ['UNREAD'],
  },
  {
    hoursAgo: 30,
    from: paul,
    subject: 'Outage last night: resolved',
    body: 'The API outage from last night is resolved. The root cause was an expired certificate; renewal is now automated.\n\nPaul',
    labels: [],
  },
  {
    hoursAgo: 40,
    from: rita,
    subject: 'Draft term sheet v1',
    body: 'Hi Camille,\n\nAttached is the first draft of the term sheet for your review. No action needed yet.\n\nRita',
    labels: [],
  },
]

/** The account's mail, newest first. Everyone but Jonas, `empty@` and `big@` gets Camille's inbox. */
const mailOf = (account: Account, now: number): FakeMessage[] => {
  if (['jonas', 'empty'].includes(scenario(account))) return []
  if (scenario(account) === 'big') {
    return Array.from({ length: 1200 }, (_, i) => ({
      id: `b${i.toString(16).padStart(15, '0')}`,
      from: `Sender ${i % 40} <sender${i % 40}@example.test>`,
      subject: `Weekly update #${1200 - i}`,
      body: `Routine update number ${1200 - i}. Nothing needs your attention.`,
      date: now - (i + 1) * hour,
      labels: i % 5 === 0 ? ['INBOX', 'UNREAD'] : ['INBOX'],
    }))
  }
  return triage.map(({ hoursAgo, labels, ...message }, i) => ({
    ...message,
    id: `18f2a0c1d4e5f60${i + 1}`,
    date: now - hoursAgo * hour,
    labels: ['INBOX', ...labels],
  }))
}

const ageUnits = new Map([
  ['d', day],
  ['m', 30 * day],
  ['y', 365 * day],
])
/** `newer_than:2d` → 2 days in ms; NaN for an unknown unit, which matches nothing. */
const age = (value: string) => Number.parseInt(value) * (ageUnits.get(value.slice(-1)) ?? NaN)
const fold = (text: string) => text.toLowerCase()
type Search = { message: FakeMessage; to: string; now: number }
type Predicate = (value: string, search: Search) => boolean
const hasLabel: Predicate = (value, { message }) => message.labels.includes(value.toUpperCase())
const operators = new Map<string, Predicate>([
  ['is', (value, search) => (value === 'read' ? !hasLabel('unread', search) : hasLabel(value, search))],
  ['in', hasLabel],
  ['label', hasLabel],
  [
    'category',
    (value, { message }) =>
      value === 'primary'
        ? !message.labels.some((label) => label.startsWith('CATEGORY_'))
        : message.labels.includes(`CATEGORY_${value.toUpperCase()}`),
  ],
  ['from', (value, { message }) => fold(message.from).includes(value)],
  ['subject', (value, { message }) => fold(message.subject).includes(value)],
  ['newer_than', (value, { message, now }) => message.date > now - age(value)],
  ['after', (value, { message }) => message.date >= Date.parse(value.replaceAll('/', '-'))],
])

/**
 * Gmail's `q`: the operators above, quoted phrases, `-` negation, and words (an unknown operator is a word, as in
 * Gmail). ponytail: no OR or grouping; add them if explorers' queries need them.
 */
const matchesQuery = (search: Search, query: string) =>
  [...query.matchAll(/(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)].every(([, negate, operator, quoted, bare]) => {
    const value = fold(quoted ?? bare ?? '')
    const predicate = operator ? operators.get(fold(operator)) : undefined
    const text = fold([search.message.from, search.to, search.message.subject, search.message.body].join('\n'))
    const hit = predicate ? predicate(value, search) : text.includes(operator ? `${fold(operator)}:${value}` : value)
    return negate ? !hit : hit
  })

/** Slices `items` into a Google-style page; the page token is the next offset. */
const paginate = <T>(items: T[], params: URLSearchParams, defaultSize: number) => {
  const start = Number(params.get('pageToken')) || 0
  const end = start + (Number(params.get('maxResults')) || defaultSize)
  return { page: items.slice(start, end), nextPageToken: end < items.length ? String(end) : undefined }
}

const gmailMessage = (account: Account, message: FakeMessage, params: URLSearchParams) => {
  const headers = [
    { name: 'From', value: message.from },
    { name: 'To', value: account.email },
    { name: 'Subject', value: message.subject },
    { name: 'Date', value: new Date(message.date).toUTCString() },
    { name: 'Message-ID', value: `<${message.id}@mail.gmail.test>` },
  ]
  const resource = {
    id: message.id,
    threadId: message.id,
    labelIds: message.labels,
    snippet: message.body.slice(0, 100),
    historyId: '4242',
    internalDate: String(message.date),
    sizeEstimate: message.body.length + 400,
  }
  if (params.get('format') === 'metadata') {
    // The app joins the names with commas; Google's repeated parameter takes both forms here.
    const wanted = params.getAll('metadataHeaders').flatMap((names) => fold(names).split(','))
    const metadata = wanted.length ? headers.filter((header) => wanted.includes(fold(header.name))) : headers
    return { ...resource, payload: { mimeType: 'text/plain', headers: metadata } }
  }
  const body = { size: message.body.length, data: Buffer.from(message.body).toString('base64url') }
  return { ...resource, payload: { partId: '', mimeType: 'text/plain', filename: '', headers, body } }
}

const eventTime = (time: number, allDay?: boolean) =>
  allDay
    ? { date: new Date(time).toISOString().slice(0, 10) }
    : { dateTime: new Date(time).toISOString().replace('.000Z', 'Z'), timeZone: 'UTC' }

const html = (body: string, status = 200) =>
  new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign in - Google Accounts</title>${body}`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })

/** Google's API error envelope: `errors[].reason` plus, when given, an ErrorInfo `details[].reason`. */
const googleError = (code: number, status: string, message: string, reason: string, detailReason?: string) =>
  Response.json(
    {
      error: {
        code,
        message,
        errors: [{ message, domain: 'global', reason }],
        status,
        details: detailReason
          ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: detailReason, domain: 'googleapis.com' }]
          : undefined,
      },
    },
    { status: code },
  )
const notFound = (message = 'Not Found') => googleError(404, 'NOT_FOUND', message, 'notFound')
const insufficientScope = () =>
  googleError(
    403,
    'PERMISSION_DENIED',
    'Request had insufficient authentication scopes.',
    'insufficientPermissions',
    'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  )
const tokenError = (status: number, error: string, description: string) =>
  Response.json({ error, error_description: description }, { status })

const draftSchema = z.object({ message: z.object({ raw: z.string().min(1), threadId: z.string().optional() }) })

type Grant = { account: Account; scope: string }

/** Starts the fake on 127.0.0.1:`port` (0 picks a free port). Codes and tokens live in memory, per server. */
export const createFakeGoogle = (port: number) => {
  const codes = new Map<string, Grant & { challenge: string | null; redirectUri: string }>()
  const accessTokens = new Map<string, Grant & { expiresAt: number }>()
  const refreshTokens = new Map<string, Grant>()

  const issueAccessToken = ({ account, scope }: Grant) => {
    const expiresIn = ['expired', 'revoked'].includes(scenario(account)) ? 1 : 3600
    const accessToken = `fake-access-${randomUUID()}`
    // Valid for at least 60 s: an app that refreshes on time never sees a 401, one that does not is caught.
    accessTokens.set(accessToken, { account, scope, expiresAt: Date.now() + Math.max(expiresIn, 60) * 1000 })
    return { access_token: accessToken, expires_in: expiresIn, scope, token_type: 'Bearer' }
  }

  const authorize = (params: URLSearchParams) => {
    const redirectUri = params.get('redirect_uri')
    if (params.get('client_id') !== fakeGoogleClientId) {
      return html('<h1>Error 401: invalid_client</h1><p>The OAuth client was not found.</p>', 401)
    }
    if (!redirectUri || params.get('response_type') !== 'code') return html('<h1>Error 400: invalid_request</h1>', 400)
    const account = accounts.find((candidate) => candidate.email === params.get('account'))
    if (!account) {
      const choices = accounts.map((choice) => {
        const link = new URLSearchParams(params)
        link.set('account', choice.email)
        return `<li><a href="/o/oauth2/v2/auth?${link}">${choice.name} (${choice.email})</a></li>`
      })
      return html(`<h1>Choose an account</h1><p>to continue to Thunderbolt</p><ul>${choices.join('')}</ul>`)
    }
    // `no-calendar-scope@` unticks the calendar box on the consent screen.
    const unticked = scenario(account) === 'no-calendar-scope' ? calendarRead : ''
    const scope = (params.get('scope') ?? '')
      .split(' ')
      .filter((name) => name !== unticked)
      .join(' ')
    const code = `fake-code-${randomUUID()}`
    codes.set(code, { account, scope, challenge: params.get('code_challenge'), redirectUri })
    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    target.searchParams.set('scope', scope)
    target.searchParams.set('state', params.get('state') ?? '')
    return new Response(null, { status: 302, headers: { Location: target.toString() } })
  }

  const token = (form: URLSearchParams) => {
    if (form.get('client_id') !== fakeGoogleClientId || form.get('client_secret') !== fakeGoogleClientSecret) {
      return tokenError(401, 'invalid_client', 'The OAuth client was not found.')
    }
    if (form.get('grant_type') === 'refresh_token') {
      const grant = refreshTokens.get(form.get('refresh_token') ?? '')
      if (!grant || scenario(grant.account) === 'revoked') {
        return tokenError(400, 'invalid_grant', 'Token has been expired or revoked.')
      }
      return Response.json(issueAccessToken(grant))
    }
    if (form.get('grant_type') !== 'authorization_code') {
      return tokenError(400, 'unsupported_grant_type', `Invalid grant_type: ${form.get('grant_type')}`)
    }
    const code = form.get('code') ?? ''
    const pending = codes.get(code)
    codes.delete(code)
    if (!pending) return tokenError(400, 'invalid_grant', 'Malformed auth code.')
    if (form.get('redirect_uri') !== pending.redirectUri) return tokenError(400, 'redirect_uri_mismatch', 'Bad Request')
    const verifier = form.get('code_verifier') ?? ''
    if (pending.challenge && createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) {
      return tokenError(400, 'invalid_grant', 'Invalid code verifier.')
    }
    const refreshToken = `1//fake-${randomUUID()}`
    refreshTokens.set(refreshToken, pending)
    return Response.json({ ...issueAccessToken(pending), refresh_token: refreshToken })
  }

  const api = async (request: Request, url: URL, { account, scope }: Grant) => {
    const granted = scope.split(' ')
    const now = Date.now()
    if (url.pathname === '/oauth2/v2/userinfo') {
      const [givenName, familyName] = account.name.split(' ')
      const id = createHash('sha256').update(account.email).digest('hex').slice(0, 21)
      const user = { id, email: account.email, verified_email: true, name: account.name }
      return Response.json({ ...user, given_name: givenName, family_name: familyName, locale: 'en' })
    }

    const calendarPath = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/)
    if (calendarPath) {
      if (scenario(account) === 'no-calendar-api') {
        return googleError(
          403,
          'PERMISSION_DENIED',
          'Google Calendar API has not been used in project 000000000000 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=000000000000 then retry.',
          'accessNotConfigured',
          'SERVICE_DISABLED',
        )
      }
      if (!granted.includes(calendarRead)) return insufficientScope()
      const calendarId = decodeURIComponent(calendarPath[1])
      const ownerEmail = calendarId === 'primary' ? account.email : calendarId
      const events = calendarsOf(account, now).get(ownerEmail)
      if (!events) return notFound()
      // Unknown parameters are ignored, as Google does.
      const timeMin = Date.parse(url.searchParams.get('timeMin') ?? '') || -Infinity
      const timeMax = Date.parse(url.searchParams.get('timeMax') ?? '') || Infinity
      const inWindow = events
        .filter((item) => item.end > timeMin && item.start < timeMax)
        .sort((a, b) => a.start - b.start)
      const { page, nextPageToken } = paginate(inWindow, url.searchParams, 250)
      const items = page.map((item) => ({
        kind: 'calendar#event',
        id: `${item.summary.toLowerCase().replace(/[^a-z0-9]/g, '')}${item.start.toString(32)}`,
        status: 'confirmed',
        summary: item.summary,
        start: eventTime(item.start, item.allDay),
        end: eventTime(item.end, item.allDay),
        organizer: { email: ownerEmail },
      }))
      return Response.json({ kind: 'calendar#events', summary: ownerEmail, timeZone: 'UTC', items, nextPageToken })
    }

    const gmailPath = url.pathname.match(/^\/gmail\/v1\/users\/me\/(threads|messages|drafts)(?:\/([^/]+))?$/)
    if (!gmailPath) return notFound()
    const [, collection, id] = gmailPath
    if (collection === 'drafts') {
      if (request.method !== 'POST' || id) return notFound()
      if (!granted.includes(gmailCompose)) return insufficientScope()
      const draft = draftSchema.safeParse(await request.json().catch(() => undefined))
      if (!draft.success) return googleError(400, 'INVALID_ARGUMENT', 'Invalid draft', 'invalidArgument')
      const messageId = randomUUID().replaceAll('-', '').slice(0, 16)
      const threadId = draft.data.message.threadId ?? messageId
      return Response.json({ id: `r-${messageId}`, message: { id: messageId, threadId, labelIds: ['DRAFT'] } })
    }
    if (!granted.includes(gmailRead)) return insufficientScope()
    const messages = mailOf(account, now)
    if (id) {
      const message = messages.find((candidate) => candidate.id === id)
      if (!message) return notFound('Requested entity was not found.')
      const resource = gmailMessage(account, message, url.searchParams)
      return Response.json(collection === 'threads' ? { id, historyId: '4242', messages: [resource] } : resource)
    }
    const labelIds = url.searchParams.getAll('labelIds')
    const query = url.searchParams.get('q') ?? ''
    const listed = messages.filter(
      (message) =>
        labelIds.every((label) => message.labels.includes(label)) &&
        matchesQuery({ message, to: account.email, now }, query),
    )
    const { page, nextPageToken } = paginate(listed, url.searchParams, 100)
    const entries = page.map((message) =>
      collection === 'threads'
        ? { id: message.id, snippet: message.body.slice(0, 100), historyId: '4242' }
        : { id: message.id, threadId: message.id },
    )
    // Gmail leaves the list out when it is empty.
    return Response.json({
      [collection]: entries.length ? entries : undefined,
      nextPageToken,
      resultSizeEstimate: listed.length,
    })
  }

  const route = async (request: Request, url: URL) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') ?? '',
          'Access-Control-Max-Age': '3600',
        },
      })
    }
    if (url.pathname === '/o/oauth2/v2/auth') return authorize(url.searchParams)
    if (url.pathname === '/token' && request.method === 'POST') return token(new URLSearchParams(await request.text()))
    const grant = accessTokens.get(request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '')
    if (!grant || grant.expiresAt < Date.now()) {
      return googleError(
        401,
        'UNAUTHENTICATED',
        'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
        'authError',
      )
    }
    return api(request, url, grant)
  }

  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const url = new URL(request.url)
      const response = await route(request, url)
      // The browser calls these APIs directly, not through the backend proxy.
      response.headers.set('Access-Control-Allow-Origin', '*')
      console.log(`[fake-google] ${request.method} ${url.pathname} ${response.status}`)
      return response
    },
  })
}
