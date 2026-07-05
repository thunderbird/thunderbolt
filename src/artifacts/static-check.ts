/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type * as acornNs from 'acorn'
import type * as csstreeNs from 'css-tree'

/** A syntax-level problem found in an artifact's inline JS or CSS. */
export type StaticIssue = {
  source: 'js' | 'css'
  message: string
  line?: number
  column?: number
}

type InlineScript = { code: string; module: boolean }

/** `<script>` types the browser runs as JS. Everything else (importmap, JSON/text data islands, templates) is not JS and must not be parsed as such. */
const jsScriptTypes = new Set(['', 'module', 'text/javascript', 'application/javascript'])

/**
 * Extract inline JS `<script>` (no `src`) and `<style>` blocks with the platform's
 * own HTML parser (`DOMParser`) — no third-party HTML parser needed, and it
 * matches how a browser tokenizes the document. Non-JS scripts (importmaps, JSON
 * data islands, templates) are skipped so they aren't falsely flagged as bad JS.
 */
const extractInlineBlocks = (html: string): { scripts: InlineScript[]; styles: string[] } => {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  const scripts = [...doc.querySelectorAll('script')]
    .filter((el) => {
      if (el.getAttribute('src') || (el.textContent ?? '').trim().length === 0) {
        return false
      }
      return jsScriptTypes.has((el.getAttribute('type') ?? '').trim().toLowerCase())
    })
    .map((el) => ({
      code: el.textContent ?? '',
      module: (el.getAttribute('type') ?? '').trim().toLowerCase() === 'module',
    }))

  const styles = [...doc.querySelectorAll('style')]
    .map((el) => el.textContent ?? '')
    .filter((code) => code.trim().length > 0)

  return { scripts, styles }
}

/** Parse each inline `<script>` with acorn; a thrown SyntaxError means invalid JS. */
const checkScripts = (scripts: InlineScript[], acorn: typeof acornNs): StaticIssue[] =>
  scripts.flatMap(({ code, module }) => {
    try {
      acorn.parse(code, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script' })
      return []
    } catch (error) {
      const syntaxError = error as { message: string; loc?: { line: number; column: number } }
      return [
        {
          source: 'js' as const,
          message: syntaxError.message,
          line: syntaxError.loc?.line,
          column: syntaxError.loc?.column,
        },
      ]
    }
  })

/**
 * Parse each inline `<style>` with css-tree in tolerant mode so every syntax
 * error is collected (not just the first). Browsers silently drop invalid CSS,
 * so this is the only layer that surfaces broken stylesheets at all.
 */
const checkStyles = (styles: string[], csstree: typeof csstreeNs): StaticIssue[] => {
  const issues: StaticIssue[] = []
  for (const css of styles) {
    csstree.parse(css, {
      // Inline type on purpose: css-tree's runtime SyntaxError carries line/column,
      // but @types/css-tree's SyntaxParseError omits them — don't "fix" to that type.
      onParseError: (error: { message?: string; rawMessage?: string; line?: number; column?: number }) =>
        issues.push({
          source: 'css',
          message: error.rawMessage ?? error.message ?? 'CSS parse error',
          line: error.line,
          column: error.column,
        }),
    })
  }
  return issues
}

/**
 * Fast, execution-free pre-check of an artifact's inline JS and CSS syntax.
 * Runs before the heavier runtime iframe pass; when it finds problems it yields
 * precise line/column messages the agent can use to self-correct. acorn and
 * css-tree are imported on demand so they stay out of the entry bundle — only
 * artifact verification pays for them.
 */
export const staticCheckHtml = async (html: string): Promise<StaticIssue[]> => {
  const { scripts, styles } = extractInlineBlocks(html)
  if (scripts.length === 0 && styles.length === 0) {
    return []
  }
  const [acorn, csstree] = await Promise.all([import('acorn'), import('css-tree')])
  return [...checkScripts(scripts, acorn), ...checkStyles(styles, csstree)]
}
