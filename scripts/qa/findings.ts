/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'

const areas = [
  'chat',
  'settings',
  'skills',
  'projects',
  'widgets',
  'layout',
  'i18n',
  'models',
  'sync',
  'auth',
  'onboarding',
  'data',
  'security',
  'other',
] as const
const oracleTypes = [
  'page-error',
  'console-error',
  'http-5xx',
  'lost-on-reload',
  'stuck',
  'overflow',
  'assert-failed',
] as const

export type Area = (typeof areas)[number]
export type Severity = 'Urgent' | 'High' | 'Medium' | 'Low'

/** A finding that passed the oracle check: a known oracle type backed by quoted evidence. */
export const findingSchema = z.object({
  title: z.string().min(1),
  area: z.enum(areas),
  charter: z.string().min(1),
  viewport: z.enum(['desktop', 'phone']),
  oracle: z.object({ type: z.enum(oracleTypes), evidence: z.string().trim().min(1) }),
  steps: z.array(z.string()).min(1),
  expected: z.string(),
  actual: z.string(),
  // Resolved inside qa-out/<charter>/, so it must not be able to point anywhere else.
  repro_spec: z.string().regex(/^repro\/[\w-]+\.spec\.ts$/),
})
export type Finding = z.infer<typeof findingSchema>

const rawFindingSchema = findingSchema.extend({ oracle: z.object({ type: z.string(), evidence: z.string() }) })
/** A finding as the explorer wrote it, before the oracle check. */
export type RawFinding = z.infer<typeof rawFindingSchema>

const findingFileSchema = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not valid JSON' })
      return z.NEVER
    }
  })
  .pipe(rawFindingSchema)

/** `qa-out/<charterDir>/findings/<id>.json` */
export type FindingFile = { charterDir: string; id: string; finding: RawFinding }
export type RejectedFile = { charterDir: string; id: string; reason: string }

/**
 * Read every `<charter>/findings/*.json` under `outDir` (the run's `qa-out` directory). Files that are
 * not JSON or do not have the finding shape come back in `rejected` with the reason.
 */
export const loadFindings = async (outDir: string) => {
  const valid: FindingFile[] = []
  const rejected: RejectedFile[] = []
  const paths = await Array.fromAsync(new Bun.Glob('*/findings/*.json').scan(outDir))
  for (const path of paths.sort()) {
    const file = { charterDir: path.split('/')[0], id: basename(path, '.json') }
    const result = findingFileSchema.safeParse(await readFile(join(outDir, path), 'utf8'))
    if (result.success) valid.push({ ...file, finding: result.data })
    else rejected.push({ ...file, reason: z.prettifyError(result.error) })
  }
  return { valid, rejected }
}

/** Oracle gate: a finding without a known oracle type and quoted evidence is only an observation. */
export const hasOracle = (finding: RawFinding): finding is Finding => findingSchema.safeParse(finding).success

/**
 * Import specifiers a repro spec may use. Assumes specs are replayed where the explorer wrote them,
 * `qa-out/<charter>/repro/<n>.spec.ts`, so the repo's `e2e/helpers` is three directories up.
 */
const allowedImports = new Set(['@playwright/test', '../../../e2e/helpers'])

/** Rejected wherever they appear, as a variable, a property, or a literal key, so shadowing cannot hide them. */
const forbiddenNames = new Set([
  'require',
  'process',
  'Bun',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'eval',
  'Function',
  'globalThis',
  // Any object reaches the Function constructor through these.
  'constructor',
  'prototype',
  // Playwright calls that start a process of the caller's choosing.
  'launch',
  'launchServer',
  'launchPersistentContext',
  'launchOptions',
  'connect',
  'connectOverCDP',
  'connectOptions',
  'executablePath',
  // `test.only` would make the replay skip every other finding's spec.
  'only',
])

/**
 * Globals a spec may use without declaring them. `Object`, `Reflect` and `Error` are left out on purpose:
 * each hands out the Function constructor without naming it. The browser names exist so that
 * `page.evaluate(() => document.title)` passes; they are undefined in the Node test runner.
 */
const allowedGlobals = new Set([
  'undefined',
  'NaN',
  'Infinity',
  'console',
  'JSON',
  'Math',
  'Date',
  'Promise',
  'Array',
  'String',
  'Number',
  'Boolean',
  'RegExp',
  'Map',
  'Set',
  'URL',
  'setTimeout',
  'parseInt',
  'parseFloat',
  'encodeURIComponent',
  'decodeURIComponent',
  'document',
  'window',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'getComputedStyle',
])

/** `__proto__` and Playwright internals such as `page._channel` all start with an underscore. */
const nameProblem = (name: string) =>
  forbiddenNames.has(name) || /^_\w/.test(name) ? `"${name}" is not allowed` : undefined

const keyProblem = (key: ts.Expression) =>
  ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
    ? nameProblem(key.text)
    : 'computed member access is not allowed'

/** `x.name`, `{ name: y } = x` and `import { name as y }` name a property, not a variable. */
const isPropertyName = (id: ts.Identifier) =>
  (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) ||
  ((ts.isBindingElement(id.parent) || ts.isImportSpecifier(id.parent)) && id.parent.propertyName === id)

const problemWith = (node: ts.Node, sourceFile: ts.SourceFile, checker: ts.TypeChecker) => {
  if (ts.isImportDeclaration(node)) {
    const from = (node.moduleSpecifier as ts.StringLiteral).text
    return allowedImports.has(from) ? undefined : `import from "${from}" is not allowed`
  }
  if (ts.isImportEqualsDeclaration(node)) return 'import = is not allowed'
  if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) return 'exports are not allowed'
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    return 'import() is not allowed'
  if (ts.isMetaProperty(node)) return `"${node.getText()}" is not allowed`
  if (node.kind === ts.SyntaxKind.ThisKeyword) return '"this" is not allowed'
  if (ts.isWithStatement(node)) return 'with statements are not allowed'
  if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
    return 'ambient declarations are not allowed'
  }
  if (ts.isElementAccessExpression(node)) return keyProblem(node.argumentExpression)
  if (ts.isComputedPropertyName(node)) return keyProblem(node.expression)
  if (ts.isBindingElement(node) && node.propertyName && ts.isStringLiteral(node.propertyName)) {
    return nameProblem(node.propertyName.text)
  }
  if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) return nameProblem(node.name.text)
  if (!ts.isIdentifier(node)) return undefined
  const problem = nameProblem(node.text)
  if (problem) return problem
  if (isPropertyName(node) || allowedGlobals.has(node.text)) return undefined
  const symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? checker.getShorthandAssignmentValueSymbol(node.parent)
    : checker.getSymbolAtLocation(node)
  return symbol?.declarations?.some((d) => d.getSourceFile() === sourceFile)
    ? undefined
    : `"${node.text}" is not a known global`
}

/**
 * Lint an LLM-written repro spec before CI replays it; returns why it was rejected (empty = passed).
 * The model wrote it after reading untrusted pages, so this is an allowlist on the AST: static imports
 * from `@playwright/test` and `e2e/helpers` only, every undeclared name must be a harmless global, and
 * `x[expr]` is refused so the name checks cannot be dodged. Type annotations are skipped (erased at runtime).
 *
 * This is defence in depth, not the boundary. Playwright's own API can still read local files and reach
 * the network, so the real boundary is that the replay step holds no secrets: none in its env, none on
 * disk (checkout with `persist-credentials: false`), and no same-user process with keys in its env
 * (readable through /proc), such as a backend holding real provider keys.
 */
export const lintReproSpec = (source: string): string[] => {
  const fileName = 'repro.spec.ts'
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const host = {
    ...ts.createCompilerHost({}),
    getSourceFile: (name: string) => (name === fileName ? sourceFile : undefined),
  }
  const program = ts.createProgram([fileName], { noLib: true, noResolve: true, types: [] }, host)
  const syntaxErrors = program.getSyntacticDiagnostics(sourceFile)
  if (syntaxErrors.length > 0) {
    return syntaxErrors.map((d) => `syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
  const checker = program.getTypeChecker()
  const reasons: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return
    const problem = problemWith(node, sourceFile, checker)
    if (problem) reasons.push(`line ${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${problem}`)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return reasons
}

/** Evidence with run-specific noise removed, so the same bug quoted in two runs compares equal. */
const signature = (evidence: string) =>
  evidence
    .toLowerCase()
    .replace(/\?\S*/g, '') // query strings
    .replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '') // uuids
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/g, '') // ISO timestamps
    .replace(/-[\w-]{8}(\.m?js|\.css)\b/g, '$1') // bundle hashes: index-DyK3a9_Q.js
    .replace(/:\d+/g, '') // ports, line:column
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/g, '') // hex ids
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)

/** Dedupe key for "the same bug" across runs: sha256(area|oracle type|normalised evidence), first 8 hex chars. */
export const fingerprint = (finding: RawFinding) =>
  createHash('sha256')
    .update(`${finding.area}|${finding.oracle.type}|${signature(finding.oracle.evidence)}`)
    .digest('hex')
    .slice(0, 8)

/** Severity of an area's non-cosmetic failures when no stronger rule applies. */
const areaSeverity = {
  auth: 'Urgent', // the table cannot tell sign-in from sign-out, so it assumes sign-in is impossible
  chat: 'High',
  models: 'High',
  settings: 'High',
  sync: 'High',
  onboarding: 'High',
  security: 'High',
  skills: 'Medium',
  projects: 'Medium',
  widgets: 'Medium',
  data: 'Medium',
  other: 'Medium',
  layout: 'Low',
  i18n: 'Low',
} satisfies Record<Area, Severity>

/**
 * Severity from area and oracle type only, so the model can never set it. An app that does not load never
 * reaches this table: the guard's smoke spec aborts the run first.
 */
export const severity = (finding: Finding): Severity => {
  const { type } = finding.oracle
  if (type === 'overflow' || type === 'console-error') return 'Low'
  if (type === 'lost-on-reload' || (type === 'page-error' && finding.area === 'chat')) return 'Urgent'
  return areaSeverity[finding.area]
}
