/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Built-in adapter — wraps the existing `aiFetchStreamingResponse` pipeline so
 * the chat layer can route every agent (built-in or ACP) through one
 * `AgentAdapter` seam. No ACP handshake; `capabilities` is null;
 * `disconnect()` is a no-op (the underlying pipeline is stateless per call).
 */

import { aiFetchStreamingResponse } from '@/ai/fetch'
import type { Agent, AgentAdapter, AgentAdapterContext } from '@/types/acp'

/** Production injection point — production binds to `aiFetchStreamingResponse`. */
export type AiFetchStreamingResponseFn = typeof aiFetchStreamingResponse

export type BuiltInAdapterOptions = {
  /** Inject for tests so we don't touch the AI SDK / DB / settings stack. */
  aiFetch?: AiFetchStreamingResponseFn
}

export const createBuiltInAdapter = (agent: Agent, options: BuiltInAdapterOptions = {}): AgentAdapter => {
  const aiFetch = options.aiFetch ?? aiFetchStreamingResponse

  const fetch = (init: RequestInit, context: AgentAdapterContext): Promise<Response> =>
    aiFetch({
      init,
      modelId: context.selectedModel.id,
      modeSystemPrompt: context.selectedMode.systemPrompt ?? undefined,
      modeName: context.selectedMode.name ?? undefined,
      mcpClients: context.mcpClients,
      httpClient: context.httpClient,
      getProxyFetch: context.getProxyFetch,
    })

  return {
    agent,
    capabilities: null,
    fetch,
    disconnect: () => {},
  }
}
