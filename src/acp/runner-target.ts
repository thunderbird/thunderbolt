/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The cloud runner as a WIRE TARGET, not an agent.
 *
 * There is one Thunderbolt agent and the user never picks where it runs; the
 * runner is just the other place a built-in thread's turns can execute. But the
 * ACP transport/auth stack is written against an `Agent` row, so the routing seam
 * synthesizes one in memory from the built-in identity plus the configured
 * endpoint. It is never persisted, never returned by discovery, and never enters
 * the picker — {@link runnerWireAgentId} exists only to key the adapter cache
 * slot, keeping the runner's connection separate from the local built-in one.
 */

import { builtInAgent } from '@/defaults/agents'
import type { Agent } from '@/types/acp'

/** Adapter-cache key for the runner connection. The leading marker makes it
 *  impossible to confuse with a real agent id (which is a slug or a uuid) if it
 *  ever shows up in a log. */
export const runnerWireAgentId = '__thunderbolt-runner__'

/** Whether an agent id addresses the runner connection rather than a real agent.
 *  The synthetic id is internal, so anything reading persisted agent ids (picker,
 *  discovery, DAL) can assert it never arrives. */
export const isRunnerWireAgentId = (agentId: string): boolean => agentId === runnerWireAgentId

/**
 * Synthesize the in-memory managed-ACP target for the cloud runner.
 *
 * @param wsUrl - the runner's ACP WebSocket endpoint from app config
 * @returns an `Agent` suitable only for `connectAcpAdapter`/`getOrConnectAdapter`
 */
export const buildRunnerWireTarget = (wsUrl: string): Agent => ({
  ...builtInAgent,
  id: runnerWireAgentId,
  type: 'managed-acp',
  transport: 'websocket',
  url: wsUrl,
  isSystem: 1,
})
