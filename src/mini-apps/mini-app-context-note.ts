/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Puts the open Mini App's current view in front of the model on every send.
 *
 * `get_app_context` reads the frame live, but a tool is only as fresh as the
 * model's decision to call it — and a model that already has a `get_app_context`
 * result in the history does not call again for "what's the total now?",
 * because from where it sits it already knows the total. The user changed the
 * screen; the model answered from the old one.
 *
 * So the host reads the frame once per send and appends what it sees to the
 * *volatile* half of the system prompt, beside the date/time. That half is
 * rebuilt every send anyway, so the cacheable stable prefix is untouched; and a
 * system note is never persisted, so the snapshot does not accumulate in the
 * thread — turn N's request carries turn N's view, once.
 *
 * The other half of the fix is {@link supersedeAppContextResults}: the stale
 * `get_app_context` results that *are* in the history get replaced with a
 * placeholder before the request goes out, so there is exactly one description
 * of the screen in the request and it is the current one.
 */

import { getToolName, isToolUIPart } from 'ai'
import type { MiniAppContext } from '@shared/mini-app-protocol'
import type { ThunderboltUIMessage } from '@/types'
import { formatMiniAppContext } from './mini-app-context-tool'
import type { MiniAppDefinition } from './registry'

export const appContextToolName = 'get_app_context'

/**
 * Build the per-send `# Current view` note.
 *
 * `data` is deliberately left out. It is arbitrary app state bounded only at
 * 20k characters, and paying for it on every send when the author's `summary`
 * usually answers the question is the wrong default. The model is told where
 * it went — the tool — so "not shown" is never mistaken for "the app has no
 * state".
 */
export const buildMiniAppContextNote = (app: MiniAppDefinition, context: MiniAppContext | null): string => {
  const header = `# Current view in ${app.name}`
  if (!context) {
    return [header, formatMiniAppContext(app, null)].join('\n\n')
  }
  const { title, summary, selection } = context
  return [
    header,
    "This is what the user is looking at as of this message. It supersedes any `get_app_context` result earlier in the conversation — answer from it, not from those. The full underlying data is not included; call `get_app_context` when you need it, or to re-read the screen after one of the app's tools has changed it.",
    formatMiniAppContext(app, { title, summary, selection }),
  ].join('\n\n')
}

export const supersededAppContextOutput =
  'Superseded — this described the screen at the time of that turn. The current view is in the system prompt.'

type Part = ThunderboltUIMessage['parts'][number]

const supersedePart = (part: Part): Part => {
  if (!isToolUIPart(part) || getToolName(part) !== appContextToolName || part.state !== 'output-available') {
    return part
  }
  return { ...part, output: supersededAppContextOutput }
}

/**
 * Replace every prior-turn `get_app_context` result with a placeholder.
 *
 * Only the tool *output* is rewritten; the call itself stays so the transcript
 * remains well-formed, and the assistant's own prose stays so "earlier you said
 * X" still works. Prior turns only — the current turn's step loop lives inside
 * `streamText` and is not in this array.
 */
export const supersedeAppContextResults = (messages: ThunderboltUIMessage[]): ThunderboltUIMessage[] =>
  messages.map((message) => {
    const parts = message.parts.map(supersedePart)
    const changed = parts.some((part, index) => part !== message.parts[index])
    return changed ? { ...message, parts } : message
  })
