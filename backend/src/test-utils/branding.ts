/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BrandingFetch, BrandingLogger } from '@/branding/download'

type LogEntry = { level: 'info' | 'warn' | 'error'; message: string; context: Record<string, unknown> }

/** A logger that keeps every entry for assertions. */
export const recordingLogger = (): BrandingLogger & { entries: LogEntry[] } => {
  const entries: LogEntry[] = []
  return {
    entries,
    info: (context, message) => entries.push({ level: 'info', message, context }),
    warn: (context, message) => entries.push({ level: 'warn', message, context }),
    error: (context, message) => entries.push({ level: 'error', message, context }),
  }
}

/** Answers a request, or passes it on with undefined. */
export type FakeRoute = (url: URL) => Response | undefined

/**
 * A fetch that answers from the first of `routes` that matches, recording every request URL.
 * Anything no route answers gets a 400, which is what Google Fonts sends for a
 * family it doesn't host.
 */
export const fakeFetch = (...routes: FakeRoute[]): { fetchFn: BrandingFetch; requests: string[] } => {
  const requests: string[] = []
  const fetchFn: BrandingFetch = async (input) => {
    const url = new URL(input)
    requests.push(url.href)
    for (const route of routes) {
      const response = route(url)
      if (response) {
        return response
      }
    }
    return new Response('', { status: 400 })
  }
  return { fetchFn, requests }
}

/** A route answering one exact URL. */
export const routeFor =
  (href: string, respond: () => Response): FakeRoute =>
  (url) =>
    url.href === href ? respond() : undefined

/** An image response of the given content type. */
export const imageResponse = (body: string, type: string) => () =>
  new Response(body, { headers: { 'content-type': type } })
