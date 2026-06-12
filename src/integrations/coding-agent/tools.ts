/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Built-in assistant tools for connecting / checking a developer's GitHub via
 * the coding-agent broker:
 *
 *  - `github_connect` → returns the per-user GitHub OAuth authorize URL to click.
 *  - `github_status`  → reports whether GitHub is connected.
 *
 * The tools take NO arguments: the developer's identity is the authenticated
 * session resolved server-side, so the model cannot connect/inspect another
 * user's account. The broker call lives in the backend; these tools only shape a
 * human-readable result for the chat.
 */

import type { HttpClient } from '@/lib/http'
import type { ToolConfig } from '@/types'
import { z } from 'zod'
import { getGithubAuthorizeUrl, getGithubStatus } from './api'

const emptyParams = z.object({}).strict()

const notConfiguredMessage = 'The coding agent is not configured on this deployment, so GitHub connect is unavailable.'
const disabledMessage = 'GitHub connect is currently disabled on the coding-agent broker.'
const failedConnectMessage = "Couldn't reach the coding-agent broker to start GitHub connect. Please try again shortly."
const failedStatusMessage =
  "Couldn't reach the coding-agent broker to check your GitHub status. Please try again shortly."

export const createConfigs = (httpClient: HttpClient): ToolConfig[] => [
  {
    name: 'github_connect',
    description:
      "Start connecting the current user's GitHub account to the coding agent. Returns a URL the user must open to authorize. Use when the user wants to connect GitHub or when a coding-agent action needs GitHub access.",
    verb: 'starting GitHub connect',
    parameters: emptyParams,
    execute: async () => {
      const result = await getGithubAuthorizeUrl(httpClient)
      if (!result.configured) {
        return { connected: false, message: notConfiguredMessage }
      }
      if (result.status === 'disabled') {
        return { connected: false, message: disabledMessage }
      }
      if (result.status === 'failed') {
        return { connected: false, message: failedConnectMessage }
      }
      return {
        url: result.url,
        message: `Connect your GitHub: ${result.url}`,
      }
    },
  },
  {
    name: 'github_status',
    description:
      "Check whether the current user's GitHub account is connected to the coding agent. Takes no arguments.",
    verb: 'checking GitHub status',
    parameters: emptyParams,
    execute: async () => {
      const result = await getGithubStatus(httpClient)
      if (!result.configured) {
        return { connected: false, message: notConfiguredMessage }
      }
      if (result.status === 'disabled') {
        return { connected: false, message: disabledMessage }
      }
      if (result.status === 'failed') {
        return { connected: false, message: failedStatusMessage }
      }
      return {
        connected: result.connected,
        message: result.connected
          ? 'Your GitHub account is connected to the coding agent.'
          : 'Your GitHub account is not connected yet. Use github_connect to get a link to connect it.',
      }
    },
  },
]
