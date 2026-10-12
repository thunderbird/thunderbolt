/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Managed-http adapter: the backend's hosted agent at `POST /v1/agent/chat`,
 * which already speaks the AI SDK UI message stream, so there is nothing to
 * translate on the way back. The chat body is posted through the authenticated
 * app client, which adds the session token, `X-App-Version` and
 * `X-App-Language`, and the streamed `Response` is handed to the AI SDK
 * unchanged.
 *
 * Stateless like the endpoint it calls: no handshake, no session to warm, no
 * transport to close. The agent picks its own model, so `selectedModel` and
 * the other built-in-only context fields are ignored.
 *
 * Not sent yet: `skillInstructions` and `projectSection`, which the chat layer
 * builds for every non-built-in agent. The endpoint drops client system
 * messages, so `/slug` skills and project instructions do nothing on this
 * agent until they are folded into the request.
 */

import { isAttachmentPart, undeliverableAttachmentsNote } from '@/lib/attachments'
import { classifyErrorKind, createChatErrorResponse } from '@/lib/error-utils'
import { HttpError, isBackendRequest } from '@/lib/http'
import { hydrateQuotesAsText } from '@/lib/quotes'
import { resolveAbsoluteBackendUrl } from '@/lib/url-utils'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { ThunderboltUIMessage } from '@/types'
import type { Agent, AgentAdapter } from '@/types/acp'
import {
  isBlankTextPart,
  isHostedAgentPartType,
  maxHostedAgentHistoryMessages,
  startOnUserMessage,
  startsAndEndsOnUserMessage,
} from '@shared/hosted-agent-history'

/** One forwarded message: only the fields the endpoint reads. `metadata` is an
 *  encrypted column (MCP tool names, sources, usage, debug transcripts), so it
 *  must never leave the device. */
type HostedAgentMessage = Pick<ThunderboltUIMessage, 'id' | 'role' | 'parts'>

/**
 * Resolve the agent's server-relative path (e.g. `/v1/agent/chat`) against the
 * backend's root: the configured API base minus its `/v1`, as `auth-context.tsx`
 * derives it. Joining under the root rather than `new URL(path, base)` keeps a
 * reverse-proxy prefix (`https://host/api/v1` → `https://host/api/v1/agent/chat`).
 *
 * The join is a string concatenation, so a path not starting with a single `/`
 * (`.evil.com/x`, `@evil.com/x`) would change the host, and the authenticated
 * client sends the bearer to any origin. Such a path is refused, and the result
 * must pass the same `isBackendRequest` check the client uses for its headers.
 */
const resolveAgentUrl = (path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`Managed HTTP agent url must be a server-relative path, got ${path}`)
  }
  const backendUrl = resolveAbsoluteBackendUrl(useLocalSettingsStore.getState().cloudUrl)
  const url = `${backendUrl.replace(/\/v1$/, '')}${path}`
  if (!isBackendRequest(url, new URL(backendUrl))) {
    throw new Error(`Managed HTTP agent url ${path} does not resolve to the backend`)
  }
  return url
}

type ChatPart = ThunderboltUIMessage['parts'][number]

/** The file a part carries, for a part the hosted agent isn't sent: an
 *  attachment reference, or an inline file. Undefined for any other part. */
const attachedFileName = (part: ChatPart): string | undefined => {
  if (isAttachmentPart(part)) {
    return part.data.filename
  }
  return part.type === 'file' ? (part.filename ?? part.mediaType) : undefined
}

/**
 * Keep only the parts the endpoint replays for the message's role, which leaves
 * out every file: the hosted agent takes no attachments for now, so the composer offers none,
 * and any already in the history (the chat switched agents) are dropped. A user
 * turn that had some gets one note listing them, so the agent can say why it
 * can't see them.
 */
const toHostedAgentMessage = ({ id, role, parts }: ThunderboltUIMessage): HostedAgentMessage => {
  const forwarded = parts.filter((part) => isHostedAgentPartType(role, part.type) && !isBlankTextPart(part))
  const undeliverable = role === 'user' ? parts.flatMap((part) => attachedFileName(part) ?? []) : []
  const note =
    undeliverable.length > 0 ? [{ type: 'text' as const, text: undeliverableAttachmentsNote(undeliverable) }] : []
  return { id, role, parts: [...forwarded, ...note] }
}

/**
 * Rewrite a `DefaultChatTransport` body into the one the hosted endpoint
 * accepts, following the rules in `@shared/hosted-agent-history`: quotes become
 * text, attachments become a note, parts the endpoint rejects for the message's
 * role are dropped along with any message they empty, and the history is capped
 * and starts on a user message.
 */
export const toManagedHttpBody = (body: string): { id: string; messages: HostedAgentMessage[] } => {
  const { id, messages = [] } = JSON.parse(body) as { id: string; messages?: ThunderboltUIMessage[] }
  const forwarded = hydrateQuotesAsText(messages.slice(-maxHostedAgentHistoryMessages))
    .map(toHostedAgentMessage)
    .filter((message) => message.parts.length > 0)
  const history = startOnUserMessage(forwarded)
  if (!startsAndEndsOnUserMessage(history)) {
    throw new Error('Hosted agent history must start and end with a user message')
  }
  return { id, messages: history }
}

/** Build the adapter for a `managed-http` agent. */
export const createManagedHttpAdapter = (agent: Agent): AgentAdapter => {
  if (!agent.url) {
    throw new Error(`Managed HTTP agent ${agent.id} has no url`)
  }
  const url = agent.url

  return {
    agent,
    capabilities: null,
    fetch: async (init, { httpClient }) => {
      if (typeof init.body !== 'string') {
        throw new Error('Managed HTTP adapter expects string body on init')
      }
      const json = toManagedHttpBody(init.body)
      try {
        return await httpClient.post(resolveAgentUrl(url), { json, signal: init.signal ?? undefined })
      } catch (error) {
        if (error instanceof HttpError) {
          return createChatErrorResponse(await error.response.text(), error.response.status, classifyErrorKind(error))
        }
        throw error
      }
    },
    ensureSession: async () => {},
    disconnect: () => {},
  }
}
