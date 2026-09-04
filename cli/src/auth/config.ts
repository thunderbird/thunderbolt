/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Static configuration for CLI auth: how to reach the backend, the OAuth client
 * id the device grant announces, and the environment seams that let CI / self-host
 * override the cloud URL and provide an environment-managed PAT for direct use.
 *
 * Mirrors the app's contract: the cloud URL is a `…/v1` base (like
 * `VITE_THUNDERBOLT_CLOUD_URL`), and Better Auth is mounted under `/v1/api/auth`
 * (see `src/contexts/auth-context.tsx`, `backend/src/auth/auth.ts` `basePath`).
 */

import { cliVersion } from '../version.ts'

/** Env values, defaulting to the process environment. Kept as a plain map so the
 *  pure resolvers can be unit-tested without touching `process.env`. */
type Env = Readonly<Record<string, string | undefined>>

export const defaultCloudUrl = 'http://localhost:8000/v1'

export const defaultAppUrl = 'http://localhost:1420'

const bakedCloudUrl = process.env.THUNDERBOLT_BUILD_CLOUD_URL
const bakedAppUrl = process.env.THUNDERBOLT_BUILD_APP_URL

export const cliClientId = 'thunderbolt-cli'

/** Preserves caller headers and adds the outer-hop app version sent to the Thunderbolt backend. */
export const backendHeaders = (headers?: RequestInit['headers']): Headers => {
  const result = new Headers(headers)
  result.set('X-App-Version', cliVersion)
  return result
}

/**
 * Resolve the backend cloud URL: the `THUNDERBOLT_CLOUD_URL` env var (the CLI's
 * mirror of the app's `VITE_THUNDERBOLT_CLOUD_URL`), the baked release default,
 * or the localhost development default.
 *
 * @param env - environment map (defaults to `process.env`)
 * @param buildDefault - URL baked into a release binary at compile time
 */
export const resolveCloudUrl = (env: Env = process.env, buildDefault = bakedCloudUrl): string =>
  env.THUNDERBOLT_CLOUD_URL || buildDefault || defaultCloudUrl

/**
 * Resolve the Thunderbolt app URL used in pairing instructions: the runtime
 * `THUNDERBOLT_APP_URL`, the baked release default, or local development.
 *
 * @param env - environment map (defaults to `process.env`)
 * @param buildDefault - URL baked into a release binary at compile time
 */
export const resolveAppUrl = (env: Env = process.env, buildDefault = bakedAppUrl): string =>
  env.THUNDERBOLT_APP_URL || buildDefault || defaultAppUrl

/**
 * Resolve a personal access token / api key from the environment. It remains
 * separate from explicit web login and cannot be persisted or cleared by the
 * CLI. An empty string counts as unset.
 *
 * @param env - environment map (defaults to `process.env`)
 */
export const resolvePatToken = (env: Env = process.env): string | undefined => env.THUNDERBOLT_TOKEN || undefined

export const patRemainsActiveNote = 'THUNDERBOLT_TOKEN remains active until it is removed from the environment.'

/** Hosts for which plain HTTP is safe (the token never leaves the machine). */
const loopbackHosts = new Set(['localhost', '::1', '[::1]'])
const ipv4LoopbackPattern = /^127(?:\.\d{1,3}){3}$/

/** Parses only backend URLs that are safe to use for account credentials. */
const parseSecureCloudUrl = (cloudUrl: string): URL | null => {
  if (!URL.canParse(cloudUrl)) return null
  const url = new URL(cloudUrl)
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  if (url.protocol === 'https:') return url
  if (
    url.protocol === 'http:' &&
    (loopbackHosts.has(url.hostname) || ipv4LoopbackPattern.test(url.hostname) || url.hostname.endsWith('.localhost'))
  ) {
    return url
  }
  return null
}

/** Normalizes a parsed, safe backend URL to its canonical `…/v1` API base. */
const normalizeApiBaseUrl = (url: URL): string => {
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  url.pathname = `${basePath}/v1`
  return url.href
}

/**
 * Normalize a safe backend cloud URL to its `…/v1` API base. Accepts URLs with
 * or without `/v1` and trailing slashes, but rejects credentials, queries, and
 * fragments so callers never serialize an ambiguous credentialed endpoint.
 *
 * @param cloudUrl - backend cloud URL
 */
export const apiBaseUrl = (cloudUrl: string): string => {
  const url = parseSecureCloudUrl(cloudUrl)
  if (url === null)
    throw new Error(
      'insecure backend URL: must use https (or loopback http) without credentials, a query, or a fragment',
    )
  return normalizeApiBaseUrl(url)
}

/**
 * Derive the Better Auth base URL from a safe cloud URL — reproducing exactly
 * how `src/contexts/auth-context.tsx` builds `baseURL` + `basePath`.
 *
 * @param cloudUrl - backend cloud URL
 */
export const authBaseUrl = (cloudUrl: string): string => `${apiBaseUrl(cloudUrl)}/api/auth`

/**
 * Whether the cloud URL is safe to send a replayable bearer to: HTTPS anywhere,
 * or plain HTTP only to a loopback host (the dev/self-host default). Blocks
 * leaking the minted token to a remote host over cleartext (RFC 8628 §3.1 mandates
 * TLS for the device flow).
 *
 * @param cloudUrl - the resolved backend cloud URL
 */
export const isSecureCloudUrl = (cloudUrl: string): boolean => {
  return parseSecureCloudUrl(cloudUrl) !== null
}
