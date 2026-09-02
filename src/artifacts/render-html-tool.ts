/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ToolConfig } from '@/types'
import { type DynamicToolUIPart, getToolName, isToolOrDynamicToolUIPart, type ToolUIPart, type UIMessage } from 'ai'
import { z } from 'zod'
import { renderHtmlToolName } from './constants'
import { verifyArtifactHtml } from './verify-html'

/**
 * What `render_html` returns to the model. On failure the errors are phrased for
 * the model to read and self-correct; on success the model just needs to know it
 * worked (the HTML is read back from the tool call's input at render time).
 */
export type RenderHtmlOutput = { ok: true } | { ok: false; errors: string[] }

/** A `render_html` tool call, whether emitted as a typed `tool-<name>` or an MCP `dynamic-tool` part. */
export type RenderHtmlPart = ToolUIPart | DynamicToolUIPart

/**
 * The one place that recognizes a `render_html` UI part. Callers used to re-do the
 * `isToolOrDynamicToolUIPart` + `getToolName` dance and then cast `input`/`output` by hand in
 * three files; this guard plus the typed accessors below keep those in sync.
 */
export const isRenderHtmlPart = (part: UIMessage['parts'][number]): part is RenderHtmlPart =>
  isToolOrDynamicToolUIPart(part) && getToolName(part) === renderHtmlToolName

/**
 * The (possibly partial, while streaming) typed input of a `render_html` part.
 *
 * Parsed with `.catch({})` rather than cast, for the same reason
 * {@link renderHtmlOutput} below is. The input genuinely *is* partial while it
 * streams, so absent fields are expected and fine — but a cast also says
 * nothing about fields that are present and the wrong type, and callers do
 * `html.match(…)` and `title?.trim()` on the result. A number `title` or an
 * object `html` from a provider that wraps arguments would throw during render
 * and take the whole message down; unwrapping to `{}` degrades to the same
 * still-streaming state the callers already handle.
 */
const renderHtmlInputSchema = z
  .object({
    // Caught per field, not just on the object: a bad `title` should not also
    // cost the `html` that was fine.
    html: z.string().optional().catch(undefined),
    title: z.string().optional().catch(undefined),
  })
  .catch({})

export const renderHtmlInput = (part: RenderHtmlPart): Partial<RenderHtmlInput> =>
  renderHtmlInputSchema.parse(part.input ?? {})

const renderHtmlOutputSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), errors: z.array(z.string()) }),
])

/**
 * The typed output of a `render_html` part once it has finished (`undefined`
 * before then).
 *
 * Parsed rather than cast, and tolerant of the MCP-style
 * `{ content: [{ type: 'text', text }], details }` envelope some providers wrap
 * a tool result in. This used to be a bare `as RenderHtmlOutput` cast, which
 * cannot fail: a wrapped result sailed through as an object whose `ok` was
 * `undefined`, so `ArtifactMessagePart` judged a perfectly good artifact
 * unverified and rendered nothing. The symptom was a card that flashed while
 * the input streamed and then vanished, on some models and not others, with
 * `{"ok":true}` sitting in the tool result the whole time.
 */
export const renderHtmlOutput = (part: RenderHtmlPart): RenderHtmlOutput | undefined => {
  const output = part.output
  if (output === undefined || output === null) {
    return undefined
  }

  const direct = renderHtmlOutputSchema.safeParse(output)
  if (direct.success) {
    return direct.data
  }

  const envelope = z
    .object({
      details: z.unknown().optional(),
      content: z.array(z.object({ type: z.literal('text'), text: z.string() })).optional(),
    })
    .safeParse(output)
  if (!envelope.success) {
    return undefined
  }

  const fromDetails = renderHtmlOutputSchema.safeParse(envelope.data.details)
  if (fromDetails.success) {
    return fromDetails.data
  }

  // Last resort: the same object re-serialised into the text block.
  const text = envelope.data.content?.find((entry) => entry.type === 'text')?.text
  if (text === undefined) {
    return undefined
  }
  // `JSON.parse` throws on anything that isn't JSON, and this runs during
  // render — an unparseable text block must degrade to "not verified", not take
  // the message down with it.
  const parsedText = z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not JSON' })
        return z.NEVER
      }
    })
    .pipe(renderHtmlOutputSchema)
    .safeParse(text)
  return parsedText.success ? parsedText.data : undefined
}

const renderHtmlParameters = z.object({
  html: z
    .string()
    .describe(
      "A complete, self-contained HTML document that runs fully OFFLINE. Inline all CSS in <style> and all JS in <script>, and embed any images/fonts as data: URIs. It has no network access — external resources (CDN scripts/styles, web fonts, remote images) and fetch/XHR are blocked, so never reference them; draw visuals with inline canvas/SVG/CSS. No build step, no local project files. It renders in a chat-width card sized to the content's natural height, so size sections to their content and avoid full-viewport (100vh/100dvh) layouts.",
    ),
  title: z.string().describe('A short, human-readable title for the artifact (e.g. "Sales dashboard").'),
})

export type RenderHtmlInput = z.infer<typeof renderHtmlParameters>

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
    try {
      const result = await verifyArtifactHtml(html)
      if (!result.ok) {
        return { ok: false, errors: result.errors }
      }
      return { ok: true }
    } catch (error) {
      /*
       * A throw here is ours, not the artifact's — the verifier failing rather
       * than the page failing. Letting it propagate puts the part into
       * `output-error`, which `ArtifactMessagePart` renders as nothing at all:
       * the card flashes while the input streams and then silently leaves, with
       * no log anywhere and no way to tell it apart from a rejected page.
       *
       * Reported as a normal `ok: false` so the model can say something useful,
       * and logged because a verifier that throws is a bug on our side.
       */
      const detail = error instanceof Error ? error.message : String(error)
      console.error('[artifacts] verification threw:', error)
      return { ok: false, errors: [`Verification could not run: ${detail}`] }
    }
  },
}
