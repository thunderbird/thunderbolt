/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire contract of the `render_html` agent tool.
 *
 * The tool exists twice — once in the browser harness and once in the runner
 * (`cloud-runner/`) — and the client's transcript pipeline recognizes an
 * artifact purely by this tool name, input, and output shape. Whichever harness
 * produced the call, the same UI renders it, so the name and shapes live here
 * rather than being restated per harness.
 *
 * What each side *verifies* is deliberately not part of this contract (the
 * browser can render, the runner cannot); each harness describes its own
 * guarantees in its own tool description.
 */

/** Name of the agent tool that renders an HTML artifact. */
export const renderHtmlToolName = 'render_html'

/** Arguments the model supplies. Carried verbatim on the ACP tool call's
 *  `rawInput`, which is where the client reads the HTML back at render time. */
export type RenderHtmlInput = {
  readonly html: string
  readonly title: string
}

/**
 * What `render_html` returns to the model. On failure the errors are phrased for
 * the model to read and self-correct, then call again; on success the model only
 * needs to know it passed, because the client re-reads the HTML from the call's
 * input instead of the output.
 */
export type RenderHtmlOutput = { ok: true } | { ok: false; errors: string[] }

/** Description of the `html` argument. Shared so both harnesses ask the model
 *  for the same document: complete, self-contained, and fully offline. */
export const renderHtmlHtmlDescription =
  "A complete, self-contained HTML document that runs fully OFFLINE. Inline all CSS in <style> and all JS in <script>, and embed any images/fonts as data: URIs. It has no network access — external resources (CDN scripts/styles, web fonts, remote images) and fetch/XHR are blocked, so never reference them; draw visuals with inline canvas/SVG/CSS. No build step, no local project files. It renders in a chat-width card sized to the content's natural height, so size sections to their content and avoid full-viewport (100vh/100dvh) layouts."

/** Description of the `title` argument. */
export const renderHtmlTitleDescription = 'A short, human-readable title for the artifact (e.g. "Sales dashboard").'
