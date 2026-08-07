/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Execution-free checks on an agent-authored HTML artifact: inline JS syntax,
 * inline CSS syntax, and references to resources an offline artifact cannot
 * load. Nothing here runs the page.
 *
 * Environment-independent on purpose. Extracting the inline blocks needs an HTML
 * parser, and the two harnesses have different ones available (the browser has
 * `DOMParser`; a server needs a non-DOM parser), so this module takes the
 * already-extracted {@link InlineBlocks} plus the JS and CSS parsers as
 * arguments. The parsers are described by the narrow structural types below
 * rather than imported from acorn/css-tree, so this module has no dependency of
 * its own — not even a type-only one — and a browser caller can keep loading the
 * real libraries on demand.
 */

/** acorn's `parse`, narrowed to the call {@link checkInlineBlocks} makes. Returns
 *  an ESTree AST walked structurally; throws a `SyntaxError` on invalid input. */
export type JsParser = (code: string, options: { ecmaVersion: 'latest'; sourceType: 'script' | 'module' }) => unknown

/** A css-tree parse error, which carries a position the model can act on. */
export type CssParseError = { message?: string; rawMessage?: string; line?: number; column?: number }

/** css-tree's `parse`, narrowed to the tolerant call {@link checkInlineBlocks}
 *  makes: every syntax error is reported through the callback instead of thrown. */
export type CssParser = (css: string, options: { onParseError: (error: CssParseError) => void }) => unknown

/** A problem found without rendering: an inline JS/CSS syntax error, or a
 *  resource reference that cannot resolve in an offline artifact. */
export type StaticIssue = {
  source: 'js' | 'css' | 'resource'
  message: string
  line?: number
  column?: number
}

/** One inline `<script>` worth parsing as JavaScript. */
export type InlineScript = { code: string; module: boolean }

/** A `<script src>` or `<link rel=stylesheet href>` an offline artifact cannot load. */
export type ExternalResource = { kind: 'script' | 'stylesheet'; url: string }

/** The parts of a document {@link checkInlineBlocks} inspects, as produced by
 *  whichever HTML parser the calling environment has. */
export type InlineBlocks = {
  scripts: InlineScript[]
  styles: string[]
  externalResources: ExternalResource[]
}

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
 * Whether a `<script type>` names a language the browser executes as JavaScript.
 *
 * @param type - raw `type` attribute value; absent counts as classic JS
 */
export const isJsScriptType = (type: string | null | undefined): boolean =>
  jsScriptTypes.has((type ?? '').trim().toLowerCase())

/** Whether a `<script type>` makes it an ES module (so `import`/`export` parse). */
export const isModuleScriptType = (type: string | null | undefined): boolean =>
  (type ?? '').trim().toLowerCase() === 'module'

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
const checkScripts = (scripts: InlineScript[], parseJs: JsParser): StaticIssue[] =>
  scripts.flatMap(({ code, module }): StaticIssue[] => {
    let ast: unknown
    try {
      ast = parseJs(code, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script' })
    } catch (error) {
      const syntaxError = error as { message: string; loc?: { line: number; column: number } }
      return [
        { source: 'js', message: syntaxError.message, line: syntaxError.loc?.line, column: syntaxError.loc?.column },
      ]
    }
    const importSources: string[] = []
    collectImportSources(ast, importSources)
    return importSources.map((specifier) => ({
      source: 'resource',
      message: `Module imports don't resolve in an offline artifact — inline the code instead of importing from ${specifier}.`,
    }))
  })

/**
 * Parse each inline `<style>` with css-tree in tolerant mode so every syntax
 * error is collected (not just the first). Browsers silently drop invalid CSS,
 * so this is the only layer that surfaces broken stylesheets at all.
 */
const checkStyles = (styles: string[], parseCss: CssParser): StaticIssue[] => {
  const issues: StaticIssue[] = []
  for (const css of styles) {
    parseCss(css, {
      onParseError: (error) =>
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

/** Phrase a blocked resource reference back in the markup form the model wrote,
 *  so it can find and inline the offending tag. */
const resourceIssue = ({ kind, url }: ExternalResource): StaticIssue => {
  const ref = kind === 'script' ? `<script src="${url}">` : `<link rel="stylesheet" href="${url}">`
  return {
    source: 'resource',
    message: `External resources are not allowed — artifacts run fully offline. Inline it instead of loading ${ref}.`,
  }
}

/**
 * Check the inline JS/CSS and resource references of one artifact document.
 *
 * @param blocks - inline scripts/styles and external references extracted from the HTML
 * @param parseJs - acorn's `parse`, for JS syntax and module-import detection
 * @param parseCss - css-tree's `parse`, used in tolerant mode for CSS syntax
 * @returns every issue found, with line/column where the parser reported one
 */
export const checkInlineBlocks = (blocks: InlineBlocks, parseJs: JsParser, parseCss: CssParser): StaticIssue[] => [
  ...blocks.externalResources.map(resourceIssue),
  ...checkScripts(blocks.scripts, parseJs),
  ...checkStyles(blocks.styles, parseCss),
]

/**
 * Render one issue as a line the model can act on. Resource issues already read
 * as instructions; syntax errors get their source and position prefixed.
 */
export const formatStaticIssue = (issue: StaticIssue): string => {
  if (issue.source === 'resource') {
    return issue.message
  }
  const location = issue.line ? ` (line ${issue.line}${issue.column ? `:${issue.column}` : ''})` : ''
  return `Invalid ${issue.source.toUpperCase()}${location}: ${issue.message}`
}
