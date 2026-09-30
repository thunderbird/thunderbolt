/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Turns the open Mini App into the `# Mini App` block of the system prompt.
 *
 * **Only the app's identity goes here — never its state.** The app's live
 * context changes on every click, and this section lands in the *stable* half of
 * the prompt (`createPromptParts`), which is fingerprinted for caching. Putting
 * changing data here would invalidate the prompt cache on every interaction.
 * `src/projects/project-search-tool.ts` rejected prompt injection for the same
 * reason; the state is read through the `get_app_context` tool instead.
 *
 * The section exists at all because a model won't reach for a tool it hasn't
 * been told about — without this the model answers "I can't see your screen"
 * and never calls `get_app_context`.
 */

import type { EmbeddedSurfaceChoice } from '@/ai/embedded-surface'
import type { MiniAppDefinition } from './registry'

/**
 * Build the `# Mini App` section, or null when the app is not the surface the
 * model should be answering about, so the prompt gains no empty heading.
 *
 * `surface` is load-bearing, not decoration. `get_app_context` is one tool name
 * for both embedded surfaces, and with an artifact selected it reports the
 * *artifact*. Emitting this section anyway told the model the user was looking
 * at the app and to call that tool to see it — a prompt pointing at a tool that
 * answers about something else. The app's action tools stay advertised either
 * way, because they stay registered; only the claim about what is on screen is
 * gated. See `chooseEmbeddedSurface` for how the surface is picked.
 */
export const buildMiniAppPromptSection = (
  app: MiniAppDefinition | null,
  surface: EmbeddedSurfaceChoice,
): string | null => {
  if (!app || surface !== 'mini-app') {
    return null
  }
  return [
    `# Mini App: ${app.name}`,
    `The user is looking at an embedded app beside this conversation. ${app.description}`,
    'Call the `get_app_context` tool to see what they are currently viewing before answering anything about it. Their view changes as they click around, so call it again rather than reusing an earlier result when the question implies they have moved on.',
  ].join('\n\n')
}
