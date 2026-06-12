/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Client calls to the backend coding-agent GitHub endpoints
 * (`/v1/coding-agent/github/*`). The backend resolves the developer's `user.id`
 * from the authenticated session and talks to the broker — the client never
 * sends a user id, so the assistant cannot act as another user.
 */

import type { HttpClient } from '@/lib/http'

const requestTimeout = 10000

/** Mirrors `backend/src/coding-agent/github-routes.ts` GithubAuthorizeUrlDto. */
export type GithubAuthorizeUrlResponse =
  | { configured: false }
  | { configured: true; status: 'ok'; url: string }
  | { configured: true; status: 'disabled' }
  | { configured: true; status: 'failed' }

/** Mirrors `backend/src/coding-agent/github-routes.ts` GithubStatusDto. */
export type GithubStatusResponse =
  | { configured: false }
  | { configured: true; status: 'ok'; connected: boolean }
  | { configured: true; status: 'disabled' }
  | { configured: true; status: 'failed' }

export const getGithubAuthorizeUrl = (httpClient: HttpClient): Promise<GithubAuthorizeUrlResponse> =>
  httpClient.get('coding-agent/github/authorize-url', { timeout: requestTimeout }).json<GithubAuthorizeUrlResponse>()

export const getGithubStatus = (httpClient: HttpClient): Promise<GithubStatusResponse> =>
  httpClient.get('coding-agent/github/status', { timeout: requestTimeout }).json<GithubStatusResponse>()
