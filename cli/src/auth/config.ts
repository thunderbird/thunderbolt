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
export const DEFAULT_CLOUD_URL = 'http://localhost:8000/v1'

/** Client id the CLI presents to the device-authorization endpoint (RFC 8628). */
export const CLI_CLIENT_ID = 'thunderbolt-cli'

/**
 * Resolve the backend cloud URL: the `THUNDERBOLT_CLOUD_URL` env var (the CLI's
 * mirror of the app's `VITE_THUNDERBOLT_CLOUD_URL`) or the localhost default.
 *
 * @param env - environment map (defaults to `process.env`)
 */
export const resolveCloudUrl = (env: Env = process.env): string => env.THUNDERBOLT_CLOUD_URL || DEFAULT_CLOUD_URL

/**
 * Derive the Better Auth base URL from a `…/v1` cloud URL. Strips a trailing
 * slash and a trailing `/v1`, then appends `/v1/api/auth` — reproducing exactly
 * how `src/contexts/auth-context.tsx` builds `baseURL` + `basePath`.
 *
 * @param cloudUrl - the `…/v1` cloud URL
 */
export const authBaseUrl = (cloudUrl: string): string =>
  `${cloudUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/api/auth`

/**
 * Resolve a personal access token / api key from the environment. When set, the
 * CLI uses it directly as the credential and skips the interactive device grant
 * (the zero-human CI / self-host escape hatch). An empty string counts as unset.
 *
 * @param env - environment map (defaults to `process.env`)
 */
export const resolvePatToken = (env: Env = process.env): string | undefined => env.THUNDERBOLT_TOKEN || undefined

/** Hosts for which plain HTTP is safe (the token never leaves the machine). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

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
  if (protocol === 'http:') return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')
  return false
}
