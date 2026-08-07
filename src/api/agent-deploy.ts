/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Frontend client for the descriptor-driven agent deploy endpoints (THU-743).
 * Uses the app's authenticated {@link HttpClient} and validates every response
 * against the shared zod contract so a drifting backend surfaces loudly.
 */

import { HttpError, type HttpClient } from '@/lib/http'
import type { Agent } from '@/types/acp'
import {
  agentCatalogResponseSchema,
  deployResponseSchema,
  deploymentStatusResponseSchema,
  undeployResponseSchema,
  type AgentDescriptor,
  type DeployRequest,
  type DeployResponse,
  type DeploymentStatusResponse,
  type UndeployResponse,
} from '@shared/agent-descriptors'

/**
 * Fetch the deployable-agent catalog. Returns `[]` when the deploy feature is
 * disabled server-side (the endpoint 404s) so callers can treat "off" and
 * "nothing to deploy" identically.
 */
export const fetchAgentCatalog = async (cloudUrl: string, httpClient: HttpClient): Promise<AgentDescriptor[]> => {
  try {
    const data = await httpClient.get(`${cloudUrl}/agents/catalog`).json<unknown>()
    return agentCatalogResponseSchema.parse(data).descriptors
  } catch (err) {
    if (err instanceof HttpError && err.response.status === 404) {
      return []
    }
    throw err
  }
}

/** Start a deploy from a validated spec. Returns the deployment id + initial status. */
export const deployAgent = async (
  cloudUrl: string,
  httpClient: HttpClient,
  request: DeployRequest,
): Promise<DeployResponse> => {
  const data = await httpClient.post(`${cloudUrl}/agents/deploy`, { json: request }).json<unknown>()
  return deployResponseSchema.parse(data)
}

/**
 * Reconstruct a persisted agent's deployment id so its status can be polled or
 * its deployment torn down after a reload — nothing device-local is stored.
 * Managed agents encode their host ref in the connection url; the id is
 * `<provider>:<ref>` (see the backend `deployment-id` codec):
 *   - Haystack → `…/haystack/ws?pipeline=<ref>` ⇒ `haystack:<ref>`
 *   - OpenClaw → `…/openclaw/ws?instance=<ref>` ⇒ `openclaw:<ref>`
 * When the `provider` field lands on the agents row it will be read off the row
 * instead of parsed from the url. Returns null for agents that carry no deployment.
 */
export const deploymentIdForAgent = (agent: Pick<Agent, 'type' | 'url'>): string | null => {
  if (agent.type !== 'managed-acp' || !agent.url) {
    return null
  }
  try {
    const params = new URL(agent.url).searchParams
    const pipeline = params.get('pipeline')
    if (pipeline) {
      return `haystack:${pipeline}`
    }
    const instance = params.get('instance')
    if (instance) {
      return `openclaw:${instance}`
    }
    return null
  } catch {
    return null
  }
}

/** Poll a deployment's live status (fetched by the backend from the host). */
export const getDeploymentStatus = async (
  cloudUrl: string,
  httpClient: HttpClient,
  deploymentId: string,
): Promise<DeploymentStatusResponse> => {
  const data = await httpClient
    .get(`${cloudUrl}/agents/deployments/${encodeURIComponent(deploymentId)}`)
    .json<unknown>()
  return deploymentStatusResponseSchema.parse(data)
}

/**
 * Trigger teardown of a deployment on its host. Resolves once the undeploy is
 * accepted (not the full unmount); throws if the trigger fails so the caller
 * keeps the local agent row and surfaces the error to the user.
 */
export const undeployAgent = async (
  cloudUrl: string,
  httpClient: HttpClient,
  deploymentId: string,
): Promise<UndeployResponse> => {
  const data = await httpClient
    .delete(`${cloudUrl}/agents/deployments/${encodeURIComponent(deploymentId)}`)
    .json<unknown>()
  return undeployResponseSchema.parse(data)
}
