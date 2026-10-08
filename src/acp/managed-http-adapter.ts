/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Managed-http adapter: a server-hosted agent (the MozFest hosted agent at
 * `POST /v1/agent/chat`) that already speaks the AI SDK UI message stream, so
 * there is nothing to translate on the way back. The chat body is posted
 * through the authenticated app client, which adds the session token,
 * `X-App-Version` and `X-App-Language`, and the streamed `Response` is handed
 * to the AI SDK unchanged.
 *
 * Stateless like the endpoint it calls: no handshake, no session to warm, no
 * transport to close. The agent picks its own model, so `selectedModel` and
 * the other built-in-only context fields are ignored.
 */

import { classifyErrorKind } from '@/lib/error-utils'
import { hydrateAttachmentsAsFileParts, type HydrationDeps } from '@/lib/attachments'
import { HttpError } from '@/lib/http'
import { hydrateQuotesAsText } from '@/lib/quotes'
import { resolveAbsoluteBackendUrl } from '@/lib/url-utils'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent, AgentAdapter } from '@/types/acp'

/** Part types the hosted endpoint forwards to the model, per role. It drops tool,
 *  reasoning and step markers itself but rejects any other part with a 400, and
 *  accepts files from the user only. */
const forwardedPartTypes: Record<string, ReadonlySet<string>> = {
  user: new Set(['text', 'file']),
  assistant: new Set(['text']),
}

/** Most messages the endpoint accepts per request (`maxHistoryMessages` in `backend/src/hosted-agent/history.ts`). */
const maxHistoryMessages = 200

type ManagedHttpAdapterOptions = {
  /** Test seam for attachment reads. */
  hydrationDeps?: HydrationDeps
}

/**
 * Resolve the agent's server-relative path (e.g. `/v1/agent/chat`) against the
 * backend's root: the configured API base minus its `/v1`, as `auth-context.tsx`
 * derives it. Joining under the root rather than `new URL(path, base)` keeps a
 * reverse-proxy prefix (`https://host/api/v1` → `https://host/api/v1/agent/chat`),
 * so the request also still counts as a backend request for the app headers.
 */
const resolveAgentUrl = (path: string): string => {
  const backendRoot = resolveAbsoluteBackendUrl(useLocalSettingsStore.getState().cloudUrl).replace(/\/v1$/, '')
  return `${backendRoot}${path}`
}

/** Keep the most recent messages within the endpoint's cap, starting on a user
 *  message because the endpoint rejects a history that starts with anything else. */
const trimHistory = (messages: ThunderboltUIMessage[]): ThunderboltUIMessage[] => {
  const recent = messages.slice(-maxHistoryMessages)
  const firstUserIndex = recent.findIndex((message) => message.role === 'user')
  return firstUserIndex === -1 ? recent : recent.slice(firstUserIndex)
}

/** Keep only the parts the endpoint accepts for each message's role, and drop
 *  messages left with none, which the endpoint would drop itself. */
const toForwardedMessages = (messages: ThunderboltUIMessage[]): ThunderboltUIMessage[] =>
  messages
    .map((message) => ({
      ...message,
      parts: message.parts.filter((part) => forwardedPartTypes[message.role]?.has(part.type)),
    }))
    .filter((message) => message.parts.length > 0)

/**
 * Rewrite a `DefaultChatTransport` body into one the hosted endpoint accepts:
 * attachments and quotes become the text and file parts the built-in pipeline
 * would send, parts the endpoint rejects for the message's role (data parts,
 * sources, assistant files) are dropped along with any message they empty, and
 * the history is trimmed to the endpoint's cap so it starts on a user message.
 * The trim runs last because filtering can empty a leading user message; the
 * coarse cap before hydration only bounds how many attachments are read.
 */
export const toManagedHttpBody = async (body: string, hydrationDeps?: HydrationDeps): Promise<string> => {
  const { messages = [], ...rest } = JSON.parse(body) as { messages?: ThunderboltUIMessage[] }
  const recent = messages.slice(-maxHistoryMessages)
  const hydrated = hydrateQuotesAsText(await hydrateAttachmentsAsFileParts(recent, hydrationDeps))
  return JSON.stringify({ ...rest, messages: trimHistory(toForwardedMessages(hydrated)) })
}

/** Serialize a rejected request the way `aiFetchStreamingResponse` does, so the
 *  chat error UI reads its status, quota window and kind. */
const toErrorResponse = async (error: HttpError): Promise<Response> => {
  const { status } = error.response
  const body = await error.response.text()
  return new Response(JSON.stringify({ error: body, status, kind: classifyErrorKind(error) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Build the adapter for a `managed-http` agent. */
export const createManagedHttpAdapter = (agent: Agent, options: ManagedHttpAdapterOptions = {}): AgentAdapter => {
  if (!agent.url) {
    throw new Error(`Managed HTTP agent ${agent.id} has no url`)
  }
  const url = agent.url

  return {
    agent,
    capabilities: null,
    fetch: async (init, { httpClient }) => {
      const body = await toManagedHttpBody(init.body as string, options.hydrationDeps)
      try {
        return await httpClient.post(resolveAgentUrl(url), {
          body,
          headers: { 'Content-Type': 'application/json' },
          signal: init.signal ?? undefined,
        })
      } catch (error) {
        if (error instanceof HttpError) {
          return toErrorResponse(error)
        }
        throw error
      }
    },
    ensureSession: async () => {},
    disconnect: () => {},
  }
}
