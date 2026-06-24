/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * User-facing GitHub connect/status HTTP endpoints backing the built-in
 * assistant's `github_connect` / `github_status` tools (the design's "MCP
 * management plane").
 *
 *  - `GET /coding-agent/github/authorize-url` → the per-user GitHub OAuth
 *    authorize URL the developer clicks to connect their account.
 *  - `GET /coding-agent/github/status` → whether the developer has connected.
 *
 * Both require an authenticated session (`{ auth: true }`); the developer's
 * Better-Auth `user.id` is resolved server-side from that session and forwarded
 * to the broker as `x-tb-user-id`. It is NEVER a request/tool argument, so the
 * model invoking the tool cannot act as another user. This reuses the same
 * broker base URL + service token as the #967 provisioning path.
 */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { createStandaloneLogger } from '@/config/logger'
import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia } from 'elysia'
import {
  fetchAuthorizeUrl,
  fetchGithubStatus,
  type AuthorizeUrlResult,
  type BrokerGithubOptions,
  type GithubStatusResult,
} from './github'

export type GithubAuthorizeUrlDto =
  | { configured: false }
  | { configured: true; status: 'ok'; url: string }
  | { configured: true; status: 'disabled' }
  | { configured: true; status: 'failed' }

export type GithubStatusDto =
  | { configured: false }
  | { configured: true; status: 'ok'; connected: boolean }
  | { configured: true; status: 'disabled' }
  | { configured: true; status: 'failed' }

/** Injectable seams so the route handlers are unit-testable without the network. */
export type CodingAgentGithubDeps = {
  fetchFn?: typeof fetch
  fetchAuthorizeUrlFn?: (opts: BrokerGithubOptions, userId: string) => Promise<AuthorizeUrlResult>
  fetchGithubStatusFn?: (opts: BrokerGithubOptions, userId: string) => Promise<GithubStatusResult>
}

/**
 * Mount the GitHub connect/status routes under the `/coding-agent` prefix.
 * Returns 200 with a discriminated DTO in all reachable cases (broker
 * unconfigured, disabled, failed, ok) so the assistant tool can phrase a useful
 * message rather than surfacing a raw HTTP error. The service token and broker
 * error bodies are never logged or returned.
 */
export const createCodingAgentGithubRoutes = (settings: Settings, auth: Auth, deps?: CodingAgentGithubDeps) => {
  const log = createStandaloneLogger(settings)
  const fetchFn = deps?.fetchFn ?? globalThis.fetch
  const authorizeUrl = deps?.fetchAuthorizeUrlFn ?? fetchAuthorizeUrl
  const githubStatus = deps?.fetchGithubStatusFn ?? fetchGithubStatus

  const brokerConfigured = (): boolean => settings.codingAgentBrokerUrl.trim().length > 0
  const brokerOpts = (): BrokerGithubOptions => ({
    brokerUrl: settings.codingAgentBrokerUrl,
    serviceToken: settings.codingAgentServiceToken,
    fetchFn,
  })

  return new Elysia({ name: 'coding-agent-github-routes', prefix: '/coding-agent/github' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (g) =>
      g
        .get('/authorize-url', async ({ user }): Promise<GithubAuthorizeUrlDto> => {
          if (!brokerConfigured()) {
            return { configured: false }
          }
          const result = await authorizeUrl(brokerOpts(), user.id)
          if (result.status === 'failed') {
            log.error({ userId: user.id, reason: result.reason }, 'coding-agent: authorize-url failed')
            return { configured: true, status: 'failed' }
          }
          if (result.status === 'disabled') {
            return { configured: true, status: 'disabled' }
          }
          return { configured: true, status: 'ok', url: result.url }
        })
        .get('/status', async ({ user }): Promise<GithubStatusDto> => {
          if (!brokerConfigured()) {
            return { configured: false }
          }
          const result = await githubStatus(brokerOpts(), user.id)
          if (result.status === 'failed') {
            log.error({ userId: user.id, reason: result.reason }, 'coding-agent: github status failed')
            return { configured: true, status: 'failed' }
          }
          if (result.status === 'disabled') {
            return { configured: true, status: 'disabled' }
          }
          return { configured: true, status: 'ok', connected: result.connected }
        }),
    )
}
