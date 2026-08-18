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
 * The value returned is the last context the app published over the bridge, not
 * a live pull — the protocol is push-only (see `mini-app-store.ts`). An app that
 * publishes on every meaningful change keeps this fresh; one that doesn't will
 * read stale, which is a bug in the app rather than here.
 */

import { tool, type Tool } from 'ai'
import { z } from 'zod'
import type { MiniAppContext } from '@shared/mini-app-protocol'
import type { MiniAppDefinition } from './registry'

export type MiniAppContextToolDeps = {
  /** Snapshot reader, injected so tests don't need the store. */
  getSnapshot: () => { app: MiniAppDefinition | null; context: MiniAppContext | null }
}

/**
 * Render the context for the model. Structured data is JSON so the model can
 * quote exact figures; the prose summary leads because it's what the app author
 * wrote deliberately for this purpose.
 */
export const formatMiniAppContext = (app: MiniAppDefinition, context: MiniAppContext | null): string => {
  if (!context) {
    return `The user has ${app.name} open but it hasn't reported any state yet. Tell them what you can see is empty rather than guessing, and suggest they interact with the app.`
  }
  const parts = [`Currently viewing: ${context.title}`, context.summary]
  if (context.selection !== undefined) {
    parts.push(`Selected:\n${JSON.stringify(context.selection, null, 2)}`)
  }
  if (context.data !== undefined) {
    parts.push(`Full state:\n${JSON.stringify(context.data, null, 2)}`)
  }
  return parts.join('\n\n')
}

export const createMiniAppContextTool = ({
  getSnapshot,
}: MiniAppContextToolDeps): Tool<Record<string, never>, string> =>
  tool({
    description:
      'Read what the user is currently looking at in the embedded app beside this chat. Returns the view they have ' +
      'open, anything they have selected, and the underlying data. Call this before answering any question about ' +
      '"this", "that", "the model", "the numbers", or anything else that refers to what is on their screen. Their ' +
      'view changes as they click, so call it again on a follow-up rather than reusing an earlier result.',
    inputSchema: z.object({}),
    execute: async () => {
      const { app, context } = getSnapshot()
      if (!app) {
        return 'No app is currently open, so there is nothing on screen to read.'
      }
      return formatMiniAppContext(app, context)
    },
  })
