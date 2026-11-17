/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appOrigin, backendUrl, seedPassword } from './config'

/** Cookies per origin, as a browser keeps them, for one sign-in. */
const createCookieJar = () => {
  const jar = new Map<string, Map<string, string>>()
  return {
    store: (url: string, response: Response) => {
      const origin = new URL(url).origin
      const cookies = jar.get(origin) ?? new Map<string, string>()
      for (const entry of response.headers.getSetCookie()) {
        const [pair] = entry.split(';')
        const separator = pair.indexOf('=')
        cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1))
      }
      jar.set(origin, cookies)
    },
    header: (url: string) =>
      [...(jar.get(new URL(url).origin) ?? new Map<string, string>()).entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
  }
}

const decodeHtml = (value: string) =>
  value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#x3D;', '=').replaceAll('&#61;', '=')

const formAction = (html: string) => {
  const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1]
  if (!action) {
    throw new Error(`No form on the page: ${html.slice(0, 300)}`)
  }
  return decodeHtml(action)
}

const hiddenInput = (html: string, name: string) => {
  const value = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`))?.[1]
  return value === undefined ? null : decodeHtml(value)
}

export type SsoSignIn = {
  /** The backend's final answer: a redirect to the app on success, or to `/sso-error`. */
  status: number
  location: string | null
  /** The session cookie the backend set, empty when it set none. */
  cookie: string
  /** The `error` the backend redirected with, if any. */
  error: string | null
}

/**
 * Sign in through a Thunderbolt SSO connection with the realm's real login form, as a browser
 * would: start at the backend, submit the Keycloak form, and follow the response back. OIDC returns
 * through the callback redirect; SAML through the auto-posting form Keycloak answers with.
 */
export const signInThroughKeycloak = async (
  providerId: string,
  username: string,
  password = seedPassword,
): Promise<SsoSignIn> => {
  const jar = createCookieJar()
  const go = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string>), Cookie: jar.header(url) },
    })
    jar.store(url, response)
    return response
  }

  /** Keycloak answers a SAML login with a page that posts the response to the ACS. */
  const postSamlForm = async (page: Response) => {
    const html = await page.text()
    const samlResponse = hiddenInput(html, 'SAMLResponse')
    if (!samlResponse) {
      throw new Error(`Keycloak answered the login with ${page.status}: ${html.slice(0, 300)}`)
    }
    const relayState = hiddenInput(html, 'RelayState')
    return go(formAction(html), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SAMLResponse: samlResponse, ...(relayState ? { RelayState: relayState } : {}) }),
    })
  }

  const startUrl = `${backendUrl}/v1/api/auth/sign-in/sso`
  const start = await go(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: appOrigin },
    body: JSON.stringify({ providerId, callbackURL: `${appOrigin}/` }),
  })
  if (!start.ok) {
    return { status: start.status, location: null, cookie: '', error: await start.text() }
  }
  const authorizeUrl = ((await start.json()) as { url: string }).url
  const loginPage = await go(authorizeUrl)
  const loginHtml = await loginPage.text()
  const submitted = await go(formAction(loginHtml), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  })

  const final = submitted.status === 302 ? await go(submitted.headers.get('location')!) : await postSamlForm(submitted)
  const location = final.headers.get('location')
  const sessionCookie = jar
    .header(backendUrl)
    .split('; ')
    .filter((cookie) => cookie.includes('session_token'))
    .join('; ')
  return {
    status: final.status,
    location,
    cookie: final.status === 302 && !location?.includes('error=') ? sessionCookie : '',
    error: location ? new URL(location, appOrigin).searchParams.get('error') : null,
  }
}
