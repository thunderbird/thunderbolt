/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Server-side validation of an agent-authored HTML artifact — the runner half of
 * `render_html`.
 *
 * **This is static analysis only.** The document is tokenized, its inline JS is
 * parsed by acorn, its inline CSS by css-tree, and resource references are
 * rejected. Nothing is executed: no DOM, no iframe, no browser engine, no
 * network. A page whose syntax is valid but whose logic throws at runtime passes
 * here; it is the client that actually renders the artifact, and that is where
 * runtime failures surface.
 *
 * Block extraction uses `htmlparser2` rather than a full spec tree builder
 * (`parse5`): the checks only need raw-text element contents plus a handful of
 * attributes, which htmlparser2's tokenizer gets right at a fraction of the
 * dependency weight. The shared logic in `shared/artifacts/static-check.ts` —
 * which JS MIME types execute, module-import detection, issue phrasing — is the
 * same code the browser harness runs, so the two verdicts cannot drift.
 */

import { parse as parseJs } from 'acorn'
import { parse as parseCss } from 'css-tree'
import { Parser } from 'htmlparser2'
import type { RenderHtmlOutput } from '../../shared/artifacts/render-html-contract.ts'
import {
  checkInlineBlocks,
  formatStaticIssue,
  isJsScriptType,
  isModuleScriptType,
  type ExternalResource,
  type InlineBlocks,
  type StaticIssue,
} from '../../shared/artifacts/static-check.ts'

/** A `<link>` counts as a stylesheet when `rel` contains the `stylesheet` token. */
const isStylesheetLink = (rel: string | undefined): boolean =>
  (rel ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .includes('stylesheet')

/**
 * Tokenize the document and collect the inline `<script>`/`<style>` bodies plus
 * every external script/stylesheet reference.
 *
 * `<script>` and `<style>` are raw-text elements, so htmlparser2 hands their
 * contents through `ontext` undecoded — exactly the source the browser would
 * execute. Scripts with a `src`, an empty body, or a non-JS `type` (importmap,
 * JSON data island, template) are not JavaScript and are left unparsed.
 *
 * @param html - the complete artifact document
 */
export const extractInlineBlocks = (html: string): InlineBlocks => {
  const scripts: InlineBlocks['scripts'] = []
  const styles: string[] = []
  const externalResources: ExternalResource[] = []
  // Raw text accumulates across `ontext` calls: htmlparser2 may split one
  // element's body at entity or buffer boundaries.
  const state: { open: { tag: 'script' | 'style'; module: boolean; text: string } | null } = { open: null }

  const parser = new Parser({
    onopentag: (name, attribs) => {
      if (name === 'script') {
        const src = attribs.src?.trim()
        if (src) {
          externalResources.push({ kind: 'script', url: src })
          return
        }
        if (isJsScriptType(attribs.type)) {
          state.open = { tag: 'script', module: isModuleScriptType(attribs.type), text: '' }
        }
        return
      }
      if (name === 'style') {
        state.open = { tag: 'style', module: false, text: '' }
        return
      }
      if (name === 'link') {
        const href = attribs.href?.trim()
        if (href && isStylesheetLink(attribs.rel)) {
          externalResources.push({ kind: 'stylesheet', url: href })
        }
      }
    },
    ontext: (text) => {
      if (state.open) state.open.text += text
    },
    // Fires for an implied close at end-of-input too, so a document truncated
    // mid-`<style>` still gets the partial block checked rather than dropped.
    onclosetag: (name) => {
      const open = state.open
      if (!open || open.tag !== name) return
      state.open = null
      if (open.text.trim().length === 0) return
      if (open.tag === 'script') {
        scripts.push({ code: open.text, module: open.module })
      } else {
        styles.push(open.text)
      }
    },
  })
  parser.write(html)
  parser.end()

  return { scripts, styles, externalResources }
}

/** Every static problem in an artifact document, in reporting order. */
export const staticCheckHtml = (html: string): StaticIssue[] =>
  checkInlineBlocks(extractInlineBlocks(html), parseJs, parseCss)

/**
 * Statically validate an artifact and phrase any problems for the model.
 *
 * @param html - the complete, self-contained artifact document
 * @returns `{ ok: true }` when nothing is statically wrong, otherwise the
 *   messages to hand back so the model can fix the HTML and call again
 */
export const validateArtifactHtml = (html: string): RenderHtmlOutput => {
  const issues = staticCheckHtml(html)
  if (issues.length === 0) {
    return { ok: true }
  }
  return { ok: false, errors: issues.map(formatStaticIssue) }
}
