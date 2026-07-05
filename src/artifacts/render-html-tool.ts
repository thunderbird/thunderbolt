/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ToolConfig } from '@/types'
import { z } from 'zod'
import { renderHtmlToolName } from './constants'
import { verifyArtifactHtml } from './verify-html'

/** Render target the agent picks by size; the user can flip it afterwards. */
export type ArtifactTarget = 'inline' | 'panel'

/**
 * What `render_html` returns to the model. On failure the errors are phrased for
 * the model to read and self-correct; on success the model just needs to know it
 * worked (the HTML itself is read back from the tool call's input at render time).
 */
export type RenderHtmlOutput = { ok: true; title: string; target: ArtifactTarget } | { ok: false; errors: string[] }

const renderHtmlParameters = z.object({
  html: z
    .string()
    .describe(
      'A complete, self-contained HTML document. Inline all CSS in <style> and all JS in <script>, or load libraries from a CDN via <script src>. It must run on its own with no build step and no references to local project files.',
    ),
  title: z.string().describe('A short, human-readable title for the artifact (e.g. "Sales dashboard").'),
  target: z
    .enum(['inline', 'panel'])
    .optional()
    .describe(
      'Where to show it. Defaults to "inline" — it appears directly in the chat, which is right for almost everything. Use "panel" only for large or complex artifacts (full dashboards, multi-section layouts, interactive apps/games) that need a bigger canvas. The user can toggle between the two afterwards.',
    ),
})

export type RenderHtmlInput = z.infer<typeof renderHtmlParameters>

/**
 * Agent tool that renders a self-contained HTML page as a visual artifact the
 * user sees (inline in the chat, or in a side panel). Before anything is shown,
 * `execute` verifies the artifact — static JS/CSS syntax checks plus a real
 * render in a hidden sandboxed iframe — and returns the outcome to the model, so
 * a broken page is caught in-turn and the model can fix it and call again.
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
  execute: async ({ html, title, target }: RenderHtmlInput): Promise<RenderHtmlOutput> => {
    // The built-in agent runs in the browser, so verification drives a real hidden iframe here.
    const result = await verifyArtifactHtml(html)
    if (!result.ok) {
      return { ok: false, errors: result.errors }
    }
    return { ok: true, title, target: target ?? 'inline' }
  },
}
