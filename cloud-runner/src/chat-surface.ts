/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Chat-surface guidance for runner sessions.
 *
 * The runner reuses the CLI's coding-agent system prompt, which is written for
 * a terminal and knows nothing about the chat app's native widgets. Tool
 * descriptions alone proved too weak to steer small models away from building
 * an HTML artifact for content the app renders natively (a weather "artifact"
 * cannot fetch data — artifacts are offline — so it renders broken). This
 * section rides the system prompt instead, where the model actually honors it.
 */

import type { AgentHarness } from '@earendil-works/pi-agent-core'

/** Appended to the harness system prompt on every runner turn. */
export const chatSurfaceSystemPrompt = `## Chat surface

Your output renders in the Thunderbolt chat app, not a terminal.

When an active skill defines a dedicated <widget:...> tag for the requested content (weather forecasts, link previews, maps, interactive questions), write that widget tag directly in your text response — the app renders it natively with live data. NEVER build an HTML artifact (render_html) for content a widget covers: artifacts run fully offline, cannot fetch live data, and will render broken.`

/** The harness surface the prompt binding needs — narrow so tests stand one in. */
export type PromptHost = Pick<AgentHarness, 'on'>

/** Append the chat-surface section to the system prompt of every turn. */
export const bindChatSurfacePrompt = (host: PromptHost): void => {
  host.on('before_agent_start', ({ systemPrompt }) => ({
    systemPrompt: `${systemPrompt}\n\n${chatSurfaceSystemPrompt}`,
  }))
}
