/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `get_app_context` — reads what the user is currently looking at in the open
 * Mini App.
 *
 * Registered only while a Mini App route is mounted, so an ordinary chat pays
 * nothing for it, not even a line of tool schema. This is the same trade
 * `createProjectSearchTool` makes, and for the same reason: the alternative is
 * pushing volatile state into the cacheable system prompt on every interaction.
 *
 * **Every call asks the frame.** It used to return the last context the app had
 * pushed, which put the burden on the app to re-publish on every meaningful
 * change — and an app that forgot left the model describing a screen the user
 * had already left, confidently, because nothing marks a cache as stale.
 *
 * The cost is that this can now fail: the frame may be gone, still loading, or
 * simply slow. That is the trade, and it is the right way round — "I can't see
 * your screen right now" is recoverable, and a stale answer presented as current
 * is not (THU-910).
 *
 * **The model does not need this to know what is on screen.** The host reads
 * the frame once per send and puts the view in the volatile system prompt (see
 * `mini-app-context-note.ts`), because a tool is only as fresh as the model's
 * decision to call it. What this tool adds is the `data` payload the note
 * leaves out, and a re-read mid-turn after one of the app's tools has changed
 * the screen.
 */

import { tool, type Tool } from 'ai'
import { z } from 'zod'
import { maxContextPayloadChars, type MiniAppContext } from '@shared/mini-app-protocol'
import type { MiniAppDefinition } from './registry'

export type MiniAppContextToolDeps = {
  /** Which app is open, if any. Injected so tests don't need the store. */
  getSnapshot: () => { app: MiniAppDefinition | null }
  /**
   * Ask the open app what the user is looking at.
   *
   * Resolves `null` for every way of not knowing — not connected, capability
   * never declared, unparseable answer, or no answer inside the deadline. The
   * distinction the model needs is "current state" versus "couldn't read it",
   * and both of those are here; "stale state" no longer exists.
   */
  requestContext: () => Promise<MiniAppContext | null>
}

/**
 * Render one app-supplied payload as JSON, or say why it isn't here.
 *
 * Two ways a payload doesn't make it. It can be too big — see
 * {@link maxContextPayloadChars}. Or it can be unserialisable: `postMessage`
 * clones with the structured clone algorithm, which carries cycles that
 * `JSON.stringify` throws on.
 *
 * This is the one field the host withholds rather than clamps, because it is
 * arbitrary structure: cutting JSON at a character count yields invalid JSON,
 * which is worse for the model than an honest "too large to read". Every
 * *string* the protocol bounds is clamped instead — see `clampedString`.
 *
 * Either way the model is *told*, rather than shown a section that silently
 * isn't there — "the app has no state" and "the app has more state than fits"
 * lead to very different answers, and only the app's own author can fix the
 * second one.
 */
const renderPayload = (label: string, value: unknown): string => {
  const serialised = ((): string | null => {
    try {
      return JSON.stringify(value, null, 2) ?? null
    } catch {
      return null
    }
  })()

  if (serialised === null) {
    return `${label}: the app reported a value that could not be serialised, so it is not shown here.`
  }
  if (serialised.length > maxContextPayloadChars) {
    return `${label}: withheld — the app reported ${serialised.length} characters, over the ${maxContextPayloadChars}-character limit. Answer from the summary above, and say that the full payload was too large to read.`
  }
  return `${label}:\n${serialised}`
}

/**
 * Render the context for the model. Structured data is JSON so the model can
 * quote exact figures; the prose summary leads because it's what the app author
 * wrote deliberately for this purpose.
 */
export const formatMiniAppContext = (app: MiniAppDefinition, context: MiniAppContext | null): string => {
  if (!context) {
    return `${app.name} is open, but it did not report what the user is looking at — it may still be loading, may have navigated, or may not report state at all. Say you cannot read the screen right now rather than guessing or describing anything from earlier in the conversation, and offer to try again.`
  }
  const parts = [`Currently viewing: ${context.title}`, context.summary]
  if (context.selection !== undefined) {
    parts.push(renderPayload('Selected', context.selection))
  }
  if (context.data !== undefined) {
    parts.push(renderPayload('Full state', context.data))
  }
  return parts.join('\n\n')
}

export const createMiniAppContextTool = ({
  getSnapshot,
  requestContext,
}: MiniAppContextToolDeps): Tool<Record<string, never>, string> =>
  tool({
    description:
      'Read what the user is currently looking at in the embedded app beside this chat, including the full ' +
      'underlying data. The system prompt already carries their current view as of their latest message; call ' +
      "this when you need the complete data behind it, or to re-read the screen after one of the app's tools " +
      'has changed it.',
    inputSchema: z.object({}),
    execute: async () => {
      const { app } = getSnapshot()
      if (!app) {
        return 'No app is currently open, so there is nothing on screen to read.'
      }
      return formatMiniAppContext(app, await requestContext())
    },
  })
