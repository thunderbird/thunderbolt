/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Ask the coding-agent broker to provision a fresh `GH_TOKEN` for a developer.
 *
 * The broker holds the GitHub App credentials and each user's refresh token; it
 * mints a short-lived user-to-server access token and writes it into that user's
 * workspace Secret, so Cline acts *as the developer* on GitHub. We authenticate
 * to the broker with a shared service token and identify the developer with the
 * Better-Auth `user.id` — the broker never sees the end-user's Better-Auth token.
 */

export type ProvisionResult =
  | { status: 'ok' }
  /** The developer has not connected GitHub yet (broker 409) — prompt them to. */
  | { status: 'not_connected' }
  /** The broker could not provision (misconfig / GitHub / k8s) — not the dev's fault. */
  | { status: 'failed'; reason: string }

export type ProvisionOptions = {
  /** Broker base URL, e.g. https://coding-agent-broker.thunderbird.net */
  brokerUrl: string
  /** Shared service token authenticating Thunderbolt → broker. */
  serviceToken: string
  fetchFn: typeof fetch
}

/**
 * POST /github/provision on the broker for `userId`. Maps the broker's response
 * to a {@link ProvisionResult}; the access token itself never transits here — it
 * lands directly in the workspace Secret.
 */
export const provisionWorkspaceToken = async (opts: ProvisionOptions, userId: string): Promise<ProvisionResult> => {
  const base = opts.brokerUrl.replace(/\/$/, '')
  const res = await opts.fetchFn(`${base}/github/provision`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.serviceToken}`,
      'x-tb-user-id': userId,
    },
  })
  if (res.ok) {
    return { status: 'ok' }
  }
  if (res.status === 409) {
    return { status: 'not_connected' }
  }
  return { status: 'failed', reason: `broker ${res.status}` }
}
