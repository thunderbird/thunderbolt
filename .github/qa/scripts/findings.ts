/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'
import journeys from '../journeys.json'
import platforms from '../platforms.json'

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
  'layout',
  'visual',
  'assert-failed',
  'ai-reported-failure',
] as const

/** One entry of `platforms.json`. The native ones (`maestro`) also name the app they drive. */
export type Platform = {
  id: string
  driver: 'playwright' | 'maestro'
  runner: string
  viewport: string
  mcp: string
  /** Whether the platform's sessions can use the app's real AI providers. */
  realAi: boolean
  appId?: string
  appName?: string
}

/** The platform ids of `platforms.json`. They never contain a hyphen, so a session id ends at the last one. */
export const platformIds = platforms.map((platform) => platform.id)

/** The ids of the platforms the Maestro driver runs. */
export const nativePlatformIds = (platforms as Platform[])
  .filter((platform) => platform.driver === 'maestro')
  .map((platform) => platform.id)

/** The `platforms.json` entry for an id; throws for an unknown id. */
export const platformOf = (id: string): Platform => {
  const platform = (platforms as Platform[]).find((entry) => entry.id === id)
  if (!platform) throw new Error(`unknown platform: ${id}`)
  return platform
}

/** An explore session: `<charter>-<platform>`, or `free-<case>-<platform>` for a free session. */
export type Session = { charter: string; platform: string }

/** Splits a session id at its last hyphen, and throws when what follows is not a platform id. */
export const parseSession = (session: string): Session => {
  const cut = session.lastIndexOf('-')
  const platform = session.slice(cut + 1)
  if (!platformIds.includes(platform)) throw new Error(`unknown platform in session id: ${session}`)
  return { charter: session.slice(0, cut), platform }
}

const realAiPlatformIds = platformIds.filter((id) => platformOf(id).realAi)

/**
 * Sessions explored with the app's real AI providers: three charters and the free session of every case
 * (`free-<case>-<platform>`), on every platform with `realAi` (iOS has none). Their findings replay on a stack with
 * the real providers too, where two failed runs in three confirm one, and they never go to the fix agent, whose
 * check runs on the fake AI. The workflow reads this set to plan its legs.
 */
export const realAiCharters = new Set([
  ...['c3-models-providers', 'c4-skills-projects', 'c5-widgets-connections'].flatMap((charter) =>
    realAiPlatformIds.map((platform) => `${charter}-${platform}`),
  ),
  ...journeys.flatMap((journey) => realAiPlatformIds.map((platform) => `free-${journey.id}-${platform}`)),
])

export type Area = (typeof areas)[number]
export type Severity = 'Urgent' | 'High' | 'Medium' | 'Low'

/**
 * A screenshot's path inside the session dir: the browser's `mcp/<file>` (`mcp-b/<file>` for c7's second device), or
 * the Maestro gate's `maestro/shot-<n>.<ext>`.
 */
export const screenshotFile = z.string().regex(/^(mcp(-b)?\/[\w.-]+|maestro\/shot-\d+)\.(png|jpe?g)$/)

const findingFields = z.object({
  title: z.string().min(1),
  area: z.enum(areas),
  charter: z.string().min(1),
  viewport: z.string().refine((id) => platformIds.includes(id), 'unknown platform'),
  oracle: z.object({ type: z.enum(oracleTypes), evidence: z.string().trim().min(1) }),
  steps: z.array(z.string()).min(1),
  expected: z.string(),
  actual: z.string(),
  // Both paths are resolved inside qa-out/<charter>/, so they must not be able to point anywhere else.
  repro_spec: z
    .string()
    .regex(/^repro\/[\w-]+\.spec\.ts$/)
    .optional(),
  /** The Maestro flow that proves a finding on a native platform. */
  repro_flow: z
    .string()
    .regex(/^repro\/[\w-]+\.yaml$/)
    .optional(),
  screenshot: screenshotFile.optional(),
  /** The accessible name of the element a visual finding is about, as `<role> "<name>"`. */
  element: z.string().optional(),
  /** The function id of the attempt that showed the finding, as in its attempt record. */
  function: z.string().optional(),
})

type Proof = {
  charter: string
  viewport: string
  oracle: { type: string }
  repro_spec?: string
  repro_flow?: string
  screenshot?: string
}

/**
 * A visual finding is proven by its screenshot, every other one by exactly one repro: a spec on the web, a flow on a
 * native platform. The two-device charter on Android takes either, a flow for the app or a spec for its browser.
 */
const provable = (finding: Proof) => {
  if (finding.oracle.type === 'visual') return finding.screenshot !== undefined
  if ((finding.repro_spec === undefined) === (finding.repro_flow === undefined)) return false
  if (!nativePlatformIds.includes(finding.viewport)) return finding.repro_spec !== undefined
  return finding.repro_flow !== undefined || finding.charter.startsWith('c7-two-devices')
}
const provableMessage =
  'a visual finding needs a screenshot, any other finding one repro: repro_spec on the web, repro_flow on a device'

/** A finding that passed the oracle check: a known oracle type backed by quoted evidence. */
export const findingSchema = findingFields.refine(provable, provableMessage)
export type Finding = z.infer<typeof findingSchema>

const rawFindingSchema = findingFields
  .extend({ oracle: z.object({ type: z.string(), evidence: z.string() }) })
  .refine(provable, provableMessage)
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
 * `qa-out/<charter>/repro/<n>.spec.ts`, so the repo's `e2e/helpers` and `.github/qa/layout` are three directories up.
 */
const allowedImports = new Set(['@playwright/test', '../../../e2e/helpers', '../../../.github/qa/layout'])

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
  // Playwright calls that write a file where the caller says. Later replay steps run code from this checkout, so a
  // written file could become code. `path` is the option of `screenshot`, `pdf`, `storageState`, `tracing.stop`
  // and `recordHar`. Snapshot matchers write a missing baseline under any name. `outputDir` on the test info
  // moves where Playwright saves the video and trace. A CDP session can send downloads to any folder.
  // ponytail: a denylist, so a write API added by a Playwright upgrade gets through; the fallback is a
  // read-only checkout during replay.
  'saveAs',
  'path',
  'routeFromHAR',
  'recordVideo',
  'tracing',
  'toMatchSnapshot',
  'toHaveScreenshot',
  'toMatchAriaSnapshot',
  'outputDir',
  'newCDPSession',
  // Overrides the same options as `test.use`, which `useProblem` limits. `use` itself passes only there.
  'extend',
  'use',
  // `test.only` would make the replay skip every other finding's spec; `skip` and `fixme` make it run 0 times, which
  // reads as "not reproduced".
  'only',
  'skip',
  'fixme',
])

/** The only options a spec may give `test.use`: the page's shape and locale, and c1's onboarding build URL. */
const useOptions = new Set([
  'viewport',
  'baseURL',
  'isMobile',
  'hasTouch',
  'deviceScaleFactor',
  'locale',
  'timezoneId',
  'colorScheme',
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

/**
 * `use` passes only as `x.use({ … })` with `useOptions` written inline, so it cannot be aliased or handed an option
 * the lint never sees, such as `proxy` or `storageState`.
 */
const useProblem = (id: ts.Identifier) => {
  const access = id.parent
  const call = access.parent
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.name !== id ||
    !ts.isCallExpression(call) ||
    call.expression !== access
  ) {
    return '"use" is allowed only as test.use({ … })'
  }
  const [options, ...rest] = call.arguments
  if (!options || rest.length > 0 || !ts.isObjectLiteralExpression(options)) return 'test.use takes one object literal'
  const refused = options.properties
    .map((p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
        ? p.name.text
        : p.getText(),
    )
    .filter((name) => !useOptions.has(name))
  return refused.length > 0 ? `test.use option "${refused.join('", "')}" is not allowed` : undefined
}

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
  if (node.text === 'use') return useProblem(node)
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

/** Evidence or a log line with run-specific noise removed, so the same bug quoted in two runs compares equal. */
export const normalize = (text: string) =>
  text
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

/** Normalized evidence, capped: the part of the dedupe key that says what went wrong. */
export const signature = (evidence: string) => normalize(evidence).slice(0, 200)

/**
 * Dedupe key for "the same bug" across runs and platforms, first 8 hex chars of a sha256:
 * `area|oracle type|normalized evidence`, or `area|visual|function|normalized element` for a visual finding, whose
 * evidence is the model's own description and changes wording from one week to the next.
 */
export const fingerprint = (finding: RawFinding) =>
  createHash('sha256')
    .update(
      finding.oracle.type === 'visual'
        ? `${finding.area}|visual|${finding.function ?? ''}|${signature(finding.element ?? '')}`
        : `${finding.area}|${finding.oracle.type}|${signature(finding.oracle.evidence)}`,
    )
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
  const { type, evidence } = finding.oracle
  if (type === 'console-error' || (type === 'layout' && /\[qa-layout\] overflow-/.test(evidence))) return 'Low'
  if (type === 'lost-on-reload' || (type === 'page-error' && finding.area === 'chat')) return 'Urgent'
  // Everything else, an AI reporting that a feature failed included, is a broken feature: its area decides.
  return areaSeverity[finding.area]
}
