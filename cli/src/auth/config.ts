/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Static configuration for CLI auth: how to reach the backend, the OAuth client
 * id the device grant announces, and the environment seams that let CI / self-host
 * override the cloud URL and short-circuit the interactive flow with a PAT.
 *
 * Mirrors the app's contract: the cloud URL is a `…/v1` base (like
 * `VITE_THUNDERBOLT_CLOUD_URL`), and Better Auth is mounted under `/v1/api/auth`
 * (see `src/contexts/auth-context.tsx`, `backend/src/auth/auth.ts` `basePath`).
 */

/** Env values, defaulting to the process environment. Kept as a plain map so the
 *  pure resolvers can be unit-tested without touching `process.env`. */
type Env = Record<string, string | undefined>

/** Cloud URL used when `THUNDERBOLT_CLOUD_URL` is unset — matches the app default. */
export const defaultCloudUrl = 'http://localhost:8000/v1'

/** App URL used when `THUNDERBOLT_APP_URL` is unset in a local development build. */
export const defaultAppUrl = 'http://localhost:1420'

const bakedCloudUrl = process.env.THUNDERBOLT_BUILD_CLOUD_URL
const bakedAppUrl = process.env.THUNDERBOLT_BUILD_APP_URL

/** Client id the CLI presents to the device-authorization endpoint (RFC 8628). */
export const cliClientId = 'thunderbolt-cli'

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
 * Normalize a backend cloud URL to its `…/v1` API base. Accepts URLs with or
 * without `/v1` and trailing slashes.
 *
 * @param cloudUrl - backend cloud URL
 */
export const apiBaseUrl = (cloudUrl: string): string =>
  `${cloudUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`

/**
 * Derive the Better Auth base URL from a cloud URL — reproducing exactly how
 * `src/contexts/auth-context.tsx` builds `baseURL` + `basePath`.
 *
 * @param cloudUrl - backend cloud URL
 */
export const authBaseUrl = (cloudUrl: string): string => `${apiBaseUrl(cloudUrl)}/api/auth`

/**
 * Resolve a personal access token / api key from the environment. When set, the
 * CLI uses it directly as the credential and skips the interactive device grant
 * (the zero-human CI / self-host escape hatch). An empty string counts as unset.
 *
 * @param env - environment map (defaults to `process.env`)
 */
export const resolvePatToken = (env: Env = process.env): string | undefined => env.THUNDERBOLT_TOKEN || undefined

/** Hosts for which plain HTTP is safe (the token never leaves the machine). */
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Whether the cloud URL is safe to send a replayable bearer to: HTTPS anywhere,
 * or plain HTTP only to a loopback host (the dev/self-host default). Blocks
 * leaking the minted token to a remote host over cleartext (RFC 8628 §3.1 mandates
 * TLS for the device flow).
 *
 * @param cloudUrl - the resolved backend cloud URL
 */
export const isSecureCloudUrl = (cloudUrl: string): boolean => {
  const { protocol, hostname } = new URL(cloudUrl)
  if (protocol === 'https:') return true
  if (protocol === 'http:') return loopbackHosts.has(hostname) || hostname.endsWith('.localhost')
  return false
}
