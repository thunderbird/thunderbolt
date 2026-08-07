/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The runner's `render_html` tool: the model writes a self-contained HTML page
 * and the client shows it as an artifact in the chat.
 *
 * V1 intermediate design — the runner validates *statically* only (see
 * `artifact-validation.ts`). A headless browser or a separate rendering service
 * would let the runner also confirm the page renders; neither is deployed here,
 * so the tool description says what actually happens rather than promising
 * verification the runner cannot perform. The page is really rendered when a
 * client displays the artifact, which is also where runtime errors show up.
 *
 * The client recognizes the artifact from the ACP tool call alone: the harness
 * translator copies the tool arguments onto `rawInput` (carrying `html`/`title`
 * verbatim) and the returned result onto `rawOutput`, both of which are
 * journaled — so a client that reconnects later replays the call and renders the
 * artifact without the runner storing anything extra. That is why the result
 * spreads {@link RenderHtmlOutput} across its own top level: `rawOutput` is the
 * whole tool result object, and `ok` is what the client reads off it.
 */

import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import {
  renderHtmlHtmlDescription,
  renderHtmlTitleDescription,
  renderHtmlToolName,
  type RenderHtmlInput,
  type RenderHtmlOutput,
} from '../../shared/artifacts/render-html-contract.ts'
import { validateArtifactHtml } from './artifact-validation.ts'

const renderHtmlSchema = Type.Object({
  html: Type.String({ description: renderHtmlHtmlDescription }),
  title: Type.String({ description: renderHtmlTitleDescription }),
})

/** Structured detail kept for logs and client-side UI; never the artifact body. */
type RenderHtmlDetails = { readonly title: string }

/** A Pi tool result that doubles as the client-facing {@link RenderHtmlOutput}. */
export type RenderHtmlResult = AgentToolResult<RenderHtmlDetails> & RenderHtmlOutput

const description = [
  'Render a self-contained HTML page (HTML/CSS/JS) as a visual artifact the user can see, instead of describing it in prose.',
  'Use this whenever a visual or interactive result is more useful than text: charts and data visualizations, diagrams, dashboards, formatted layouts, animations, simulations, games, or small web apps.',
  'NEVER use this tool for content that has a dedicated <widget:...> tag (weather forecasts, link previews, maps, interactive questions): this page runs fully offline, so it CANNOT fetch live data and will render broken. Write the widget tag directly in your text response instead — the app renders it natively with live data.',
  'The page is statically checked before it is accepted: its inline JS and CSS are parsed for syntax errors and external resources are rejected. It is NOT executed here, so runtime behaviour is only exercised when the page is displayed — make the logic correct by construction.',
  'If the result is { ok: false }, read the errors, fix the HTML, and call render_html again. Do not narrate the HTML source to the user.',
].join(' ')

/**
 * Validate one artifact and shape the result both readers need: the model reads
 * the text content, the client reads `ok`.
 *
 * Static failures are a normal result rather than a thrown error — the model is
 * expected to read them and call again, and a throw would surface as a failed
 * tool call the client hides instead.
 */
export const renderHtmlResult = ({ html, title }: RenderHtmlInput): RenderHtmlResult => {
  const verdict = validateArtifactHtml(html)
  const summary = verdict.ok
    ? 'The page passed static checks and is shown to the user.'
    : `The page has ${verdict.errors.length} problem(s):\n${verdict.errors.join('\n')}`
  return { ...verdict, content: [{ type: 'text', text: summary }], details: { title } }
}

/** Build the runner's `render_html` tool. */
export const createRenderHtmlTool = (): AgentTool<typeof renderHtmlSchema, RenderHtmlDetails> => ({
  name: renderHtmlToolName,
  label: 'render artifact',
  description,
  parameters: renderHtmlSchema,
  execute: async (_toolCallId, input) => renderHtmlResult(input),
})

/** The harness surface tool registration needs — narrow so tests can stand one in. */
export type ToolHost = {
  getTools: () => AgentTool[]
  setTools: (tools: AgentTool[], activeToolNames?: string[]) => Promise<void>
}

/**
 * Append `render_html` to a freshly built harness's toolset and mark it active.
 *
 * The CLI assembles the base coding toolset; artifacts are the runner's own
 * addition, so it is registered here instead. `setTools` keeps the previous
 * active list when none is passed, hence the explicit names.
 */
export const registerRenderHtmlTool = async (host: ToolHost): Promise<void> => {
  const tools = [...host.getTools(), createRenderHtmlTool()]
  await host.setTools(
    tools,
    tools.map((tool) => tool.name),
  )
}
