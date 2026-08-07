/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ToolConfig } from '@/types'
import type { RenderHtmlInput, RenderHtmlOutput } from '@shared/artifacts/render-html-contract'
import {
  renderHtmlHtmlDescription,
  renderHtmlTitleDescription,
  renderHtmlToolName,
} from '@shared/artifacts/render-html-contract'
import { type DynamicToolUIPart, getToolName, isToolOrDynamicToolUIPart, type ToolUIPart, type UIMessage } from 'ai'
import { z } from 'zod'
import { verifyArtifactHtml } from './verify-html'

export { renderHtmlToolName }
export type { RenderHtmlInput, RenderHtmlOutput }

/** A `render_html` tool call, whether emitted as a typed `tool-<name>` or an MCP `dynamic-tool` part. */
export type RenderHtmlPart = ToolUIPart | DynamicToolUIPart

/**
 * The one place that recognizes a `render_html` UI part. Callers used to re-do the
 * `isToolOrDynamicToolUIPart` + `getToolName` dance and then cast `input`/`output` by hand in
 * three files; this guard plus the typed accessors below keep those in sync.
 */
export const isRenderHtmlPart = (part: UIMessage['parts'][number]): part is RenderHtmlPart =>
  isToolOrDynamicToolUIPart(part) && getToolName(part) === renderHtmlToolName

/** The (possibly partial, while streaming) typed input of a `render_html` part. */
export const renderHtmlInput = (part: RenderHtmlPart): Partial<RenderHtmlInput> =>
  (part.input ?? {}) as Partial<RenderHtmlInput>

/** The typed output of a `render_html` part once it has finished (`undefined` before then). */
export const renderHtmlOutput = (part: RenderHtmlPart): RenderHtmlOutput | undefined =>
  part.output as RenderHtmlOutput | undefined

const renderHtmlParameters = z.object({
  html: z.string().describe(renderHtmlHtmlDescription),
  title: z.string().describe(renderHtmlTitleDescription),
})

/**
 * Agent tool that renders a self-contained HTML page as a visual artifact the
 * user sees inline in the chat (they can pop it out to a side panel). Before
 * anything is shown, `execute` verifies the artifact — static JS/CSS syntax
 * checks plus a real render in a hidden sandboxed iframe — and returns the outcome
 * to the model, so a broken page is caught in-turn and the model can fix and call again.
 */
export const renderHtmlTool: ToolConfig = {
  name: renderHtmlToolName,
  description: [
    'Render a self-contained HTML page (HTML/CSS/JS) as a visual artifact the user can see, instead of describing it in prose.',
    'Use this whenever a visual or interactive result is more useful than text: charts and data visualizations, diagrams, dashboards, formatted layouts, animations, simulations, games, or small web apps.',
    'The page is automatically verified before it is shown: its inline JS/CSS syntax is checked and it is rendered in a sandbox to confirm it loads without errors. If the result is { ok: false }, read the errors, fix the HTML, and call render_html again. Do not narrate the HTML source to the user.',
  ].join(' '),
  verb: 'Rendering artifact',
  parameters: renderHtmlParameters,
  execute: async ({ html }: RenderHtmlInput): Promise<RenderHtmlOutput> => {
    // The built-in agent runs in the browser, so verification drives a real hidden iframe here.
    const result = await verifyArtifactHtml(html)
    if (!result.ok) {
      return { ok: false, errors: result.errors }
    }
    return { ok: true }
  },
}
