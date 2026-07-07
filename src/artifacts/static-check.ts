/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type * as acornNs from 'acorn'
import type * as csstreeNs from 'css-tree'

/** A problem found before render: an inline JS/CSS syntax error, or an external resource the offline CSP blocks. */
export type StaticIssue = {
  source: 'js' | 'css' | 'resource'
  message: string
  line?: number
  column?: number
}

type InlineScript = { code: string; module: boolean }

/**
 * `<script>` types the browser runs as JS (the WHATWG JavaScript MIME-type set, plus `''`/`module`).
 * Everything else (importmap, JSON/text data islands, templates) is not JS and must not be parsed as such.
 */
const jsScriptTypes = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/x-javascript',
  'application/x-javascript',
  'text/x-ecmascript',
  'application/x-ecmascript',
  'text/jscript',
  'text/livescript',
])

/**
 * Extract inline JS `<script>` (no `src`) and `<style>` blocks with the platform's
 * own HTML parser (`DOMParser`) — no third-party HTML parser needed, and it
 * matches how a browser tokenizes the document. Non-JS scripts (importmaps, JSON
 * data islands, templates) are skipped so they aren't falsely flagged as bad JS.
 */
const extractInlineBlocks = (
  html: string,
): { scripts: InlineScript[]; styles: string[]; externalResources: string[] } => {
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

  // Any `<script src>` or `<link rel=stylesheet href>` the offline CSP blocks — and it blocks ALL
  // of them: `script-src 'unsafe-inline' 'unsafe-eval'` and `style-src 'unsafe-inline'` name no
  // scheme or host, so remote, protocol-relative, root/relative, AND `data:` script/stylesheet
  // loads all fail. Without the page's logic or styles it renders broken, but nothing throws, so
  // flag them here (regardless of URL form) rather than let verification pass on a blank page.
  const externalResources = [
    ...[...doc.querySelectorAll('script[src]')]
      .map((el) => el.getAttribute('src') ?? '')
      .filter((src) => src.trim().length > 0)
      .map((src) => `<script src="${src}">`),
    ...[...doc.querySelectorAll('link[rel~="stylesheet"][href]')]
      .map((el) => el.getAttribute('href') ?? '')
      .filter((href) => href.trim().length > 0)
      .map((href) => `<link rel="stylesheet" href="${href}">`),
  ]

  return { scripts, styles, externalResources }
}

/**
 * Walk an acorn AST collecting every module specifier: static `import`/`export … from`,
 * `export * from`, and dynamic `import('…')` with a string-literal argument. Offline artifacts
 * have no module resolution or network, so any of these silently fails at runtime — a `<script
 * type="module">` that imports a CDN URL (or even a relative path) otherwise parses clean and
 * passes verification while rendering broken.
 */
const collectImportSources = (node: unknown, sources: string[]): void => {
  if (!node || typeof node !== 'object') {
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectImportSources(child, sources)
    }
    return
  }
  const record = node as Record<string, unknown>
  const source = record.source as { type?: string; value?: unknown } | null | undefined
  if (
    (record.type === 'ImportDeclaration' ||
      record.type === 'ExportAllDeclaration' ||
      record.type === 'ExportNamedDeclaration' ||
      record.type === 'ImportExpression') &&
    source &&
    typeof source.value === 'string'
  ) {
    sources.push(source.value)
  }
  for (const key in record) {
    if (key !== 'type') {
      collectImportSources(record[key], sources)
    }
  }
}

/** Parse each inline `<script>` with acorn; a thrown SyntaxError means invalid JS, and any module import is a blocked resource. */
const checkScripts = (scripts: InlineScript[], acorn: typeof acornNs): StaticIssue[] =>
  scripts.flatMap(({ code, module }): StaticIssue[] => {
    let ast: acornNs.Program
    try {
      ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script' })
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
    const importSources: string[] = []
    collectImportSources(ast, importSources)
    return importSources.map((specifier) => ({
      source: 'resource' as const,
      message: `Module imports don't resolve in an offline artifact — inline the code instead of importing from ${specifier}.`,
    }))
  })

/**
 * Parse each inline `<style>` with css-tree in tolerant mode so every syntax
 * error is collected (not just the first). Browsers silently drop invalid CSS,
 * so this is the only layer that surfaces broken stylesheets at all.
 */
const checkStyles = (styles: string[], parseCss: typeof csstreeNs.parse): StaticIssue[] => {
  const issues: StaticIssue[] = []
  for (const css of styles) {
    parseCss(css, {
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
  const { scripts, styles, externalResources } = extractInlineBlocks(html)
  const resourceIssues: StaticIssue[] = externalResources.map((ref) => ({
    source: 'resource',
    message: `External resources are not allowed — artifacts run fully offline. Inline it instead of loading ${ref}.`,
  }))
  if (scripts.length === 0 && styles.length === 0) {
    return resourceIssues
  }
  // `css-tree/parser` is the lean, parse-only entry: its import graph never reaches the
  // lexer or the ~739 KB mdn-data grammar, so those tree-shake out of the on-demand chunk
  // while syntax parsing (all we need) is unchanged. See css-tree-parser.d.ts for its type.
  const [acorn, csstreeParser] = await Promise.all([import('acorn'), import('css-tree/parser')])
  return [...resourceIssues, ...checkScripts(scripts, acorn), ...checkStyles(styles, csstreeParser.default)]
}
