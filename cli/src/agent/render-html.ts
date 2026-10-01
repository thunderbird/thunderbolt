/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `render_html` — return a chart or page as a visual artifact instead of a file.
 *
 * A hosted agent has no filesystem anyone can reach: `/workspace` lives inside
 * a container, and it is discarded on the next deploy. Asked for a chart, an
 * agent holding only `write` does the one thing it can and saves an .html file
 * nobody will ever open. This tool is the reachable answer — the HTML travels
 * back over ACP and the client renders it in the chat.
 *
 * The contract is the app's, not ours: the tool name and the `{ ok }` result
 * shape match `src/artifacts/render-html-tool.ts`, because the app recognises an
 * artifact by tool name and reads that field to decide whether to lift it out of
 * the tool group. Drift in either one turns an artifact back into a plain tool
 * call, so they are checked against each other in `render-html.test.ts`.
 *
 * Verification is deliberately weaker here than in the app. The browser tool
 * parses inline JS and CSS (acorn, css-tree) and renders in a hidden iframe;
 * this process has no DOM and should not pull a parser into the compiled binary
 * for it. What it does instead is catch the one failure that is both common and
 * decidable without a DOM — referencing a resource the offline artifact frame
 * blocks — and leave everything else to the client, which renders sandboxed
 * regardless.
 */

import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** Mirrors `renderHtmlToolName` in `src/artifacts/constants.ts`. */
export const renderHtmlToolName = 'render_html'

/**
 * Cap on the HTML a single artifact may carry. The document crosses the ACP
 * WebSocket in one frame and is echoed back to the model as tool output, so an
 * unbounded page costs both the relay's queue budget and the turn's context.
 */
export const maxArtifactBytes = 512_000

/** Mirrors `RenderHtmlOutput` in `src/artifacts/render-html-tool.ts`. */
export type RenderHtmlOutput = { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] }

const renderHtmlSchema = Type.Object({
  html: Type.String({
    description:
      'A complete, self-contained HTML document that runs fully OFFLINE. Inline all CSS in <style> and all JS in <script>, and embed any images/fonts as data: URIs. It has no network access — external resources (CDN scripts/styles, web fonts, remote images) and fetch/XHR are blocked, so never reference them; draw visuals with inline canvas/SVG/CSS. It renders in a chat-width card sized to the content, so avoid full-viewport (100vh/100dvh) layouts.',
  }),
  title: Type.String({ description: 'A short, human-readable title for the artifact (e.g. "Weekly subscriptions").' }),
})

/**
 * Attribute values and CSS/JS references the offline artifact frame cannot load.
 * Matches `http:`, `https:` and protocol-relative `//host` in the places a
 * document actually fetches from, rather than anywhere in the text — an absolute
 * URL inside visible copy or a comment is not a broken reference.
 */
const externalReferencePatterns: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  // No `g` flag: these are shared module-level objects tested with `.test()`,
  // and a global regex carries `lastIndex` between calls — which silently skips
  // matches depending on what was checked before it.
  { label: 'src', pattern: /\bsrc\s*=\s*["']?(?:https?:)?\/\//i },
  { label: 'href', pattern: /\bhref\s*=\s*["']?(?:https?:)?\/\//i },
  { label: 'css url()', pattern: /url\(\s*["']?(?:https?:)?\/\//i },
  { label: 'import', pattern: /\bimport\s+[^;]*["'](?:https?:)?\/\//i },
  { label: 'fetch', pattern: /\bfetch\s*\(\s*["'](?:https?:)?\/\//i },
]

/** Report every external reference at once so the model can fix them in one retry. */
const externalReferenceErrors = (html: string): string[] =>
  externalReferencePatterns
    .filter(({ pattern }) => pattern.test(html))
    .map(
      ({ label }) =>
        `${label} references an external URL, which the offline artifact frame blocks. Inline the resource or embed it as a data: URI.`,
    )

/**
 * Checks decidable without a DOM. Returns the problems to hand back to the
 * model; an empty array means nothing found, not "verified".
 */
export const staticArtifactIssues = (html: string): string[] => {
  const trimmed = html.trim()
  if (trimmed.length === 0) return ['html is empty.']
  if (!trimmed.includes('<')) return ['html contains no markup.']

  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > maxArtifactBytes) {
    return [`html is ${bytes} bytes, over the ${maxArtifactBytes}-byte artifact limit. Reduce the embedded data.`]
  }

  return externalReferenceErrors(html)
}

/**
 * Builds the tool.
 *
 * `details` carries the `{ ok }` result because that is what the ACP layer
 * forwards as `rawOutput`, and the client reads the artifact verdict from there.
 */
export const createRenderHtmlTool = (): AgentTool<typeof renderHtmlSchema, RenderHtmlOutput> => ({
  name: renderHtmlToolName,
  label: 'render artifact',
  description: [
    'Render a self-contained HTML page (HTML/CSS/JS) as a visual artifact the user can see, instead of describing it in prose or writing it to a file.',
    'Use this whenever a visual result is more useful than text: charts and data visualizations, diagrams, dashboards, formatted layouts, or small interactive views.',
    'Files you write to disk are NOT visible to the user — this tool is the only way to show them something you have drawn.',
    'If the result is { ok: false }, read the errors, fix the HTML, and call render_html again. Do not narrate the HTML source to the user.',
  ].join(' '),
  parameters: renderHtmlSchema,
  execute: async (_toolCallId, { html, title }) => {
    const errors = staticArtifactIssues(html)
    if (errors.length > 0) {
      return {
        content: [{ type: 'text', text: `Artifact rejected:\n${errors.map((error) => `- ${error}`).join('\n')}` }],
        details: { ok: false, errors },
      }
    }
    return {
      content: [{ type: 'text', text: `Rendered artifact "${title}" for the user.` }],
      details: { ok: true },
    }
  },
})
