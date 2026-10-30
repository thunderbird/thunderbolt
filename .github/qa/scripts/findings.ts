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

export type Platform = {
  id: string
  driver: 'playwright' | 'maestro'
  runner: string
  viewport: string
  mcp: string
  realAi: boolean
  appId?: string
  appName?: string
}

/** Ids never contain a hyphen, so a session id ends at the last one. */
export const platformIds = platforms.map((platform) => platform.id)

export const nativePlatformIds = (platforms as Platform[])
  .filter((platform) => platform.driver === 'maestro')
  .map((platform) => platform.id)

export const platformOf = (id: string): Platform => {
  const platform = (platforms as Platform[]).find((entry) => entry.id === id)
  if (!platform) throw new Error(`unknown platform: ${id}`)
  return platform
}

/** A session id is `<charter>-<platform>`, or `free-<case>-<platform>` for a free session. */
export type Session = { charter: string; platform: string }

export const parseSession = (session: string): Session => {
  const cut = session.lastIndexOf('-')
  const platform = session.slice(cut + 1)
  if (!platformIds.includes(platform)) throw new Error(`unknown platform in session id: ${session}`)
  return { charter: session.slice(0, cut), platform }
}

const realAiPlatformIds = platformIds.filter((id) => platformOf(id).realAi)

/**
 * Sessions explored with the real AI providers, so their findings replay on those too (two failed runs in three
 * confirm one). A web fix is checked again on the real providers; a native fix runs on the fake AI, where its repro
 * flow must fail without the patch and pass with it. The workflow reads this set to plan its legs.
 */
export const realAiCharters = new Set([
  ...['c3-models-providers', 'c4-skills-projects', 'c5-widgets-connections'].flatMap((charter) =>
    realAiPlatformIds.map((platform) => `${charter}-${platform}`),
  ),
  ...journeys.flatMap((journey) => realAiPlatformIds.map((platform) => `free-${journey.id}-${platform}`)),
])

export type Area = (typeof areas)[number]
/** Most urgent first, so a lower index is a higher priority. */
const severities = ['Urgent', 'High', 'Medium', 'Low'] as const
export const severitySchema = z.enum(severities)
/** A model-proposed severity: a missing or unknown value reads as no proposal. */
export const proposedSeveritySchema = severitySchema.optional().catch(undefined)
export type Severity = z.infer<typeof severitySchema>

/** A path inside the session dir; `mcp-b/` holds c7's second device. */
export const screenshotFile = z.string().regex(/^(mcp(-b)?\/[\w.-]+|maestro\/shot-\d+)\.(png|jpe?g)$/)

export const reproFlowFile = z.string().regex(/^repro\/[\w-]+\.yaml$/)

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
  repro_flow: reproFlowFile.optional(),
  screenshot: screenshotFile.optional(),
  /** The accessible name of the element a visual finding is about, as `<role> "<name>"`. */
  element: z.string().optional(),
  /** The function id of the attempt that showed the finding, as in its attempt record. */
  function: z.string().optional(),
})

type Proof = { oracle: { type: string }; repro_spec?: string; repro_flow?: string; screenshot?: string }

/** Which repro a platform needs depends on the session dir, which the schema cannot see: `sessionProblem` checks it. */
const provable = (finding: Proof) =>
  finding.oracle.type === 'visual'
    ? finding.screenshot !== undefined
    : (finding.repro_spec === undefined) !== (finding.repro_flow === undefined)
const provableMessage = 'a visual finding needs a screenshot, any other finding one of repro_spec and repro_flow'

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

/** A finding's id within the run: `id` alone repeats across sessions. */
export const findingId = (f: Pick<FindingFile, 'charterDir' | 'id'>) => `${f.charterDir}/${f.id}`

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

const sessionOf = (dir: string) => {
  try {
    return parseSession(dir)
  } catch {
    return undefined
  }
}

/** The dir decides, never the model-written `charter` or `viewport`. */
export const sessionProblem = ({ charterDir, finding }: FindingFile): string | undefined => {
  const session = /^[\w-]+$/.test(charterDir) ? sessionOf(charterDir) : undefined
  if (!session) return `not a session dir: ${charterDir}`
  if (finding.oracle.type === 'visual') return undefined
  if (!nativePlatformIds.includes(session.platform)) {
    return finding.repro_flow ? 'a web session proves a finding with a repro_spec, not a repro_flow' : undefined
  }
  if (finding.repro_spec && session.charter !== 'c7-two-devices') {
    return 'a native session proves a finding with a repro_flow; only c7 on Android also takes a repro_spec'
  }
  return undefined
}

/** Specs replay where the explorer wrote them, `qa-out/<charter>/repro/<n>.spec.ts`, three levels below the repo. */
const allowedImports = new Set([
  '@playwright/test',
  '../../../e2e/helpers',
  '../../../.github/qa/layout',
  '../../../.github/qa/ports',
])

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
  // shortcut: a denylist, so a write API added by a Playwright upgrade gets through; the fallback is a
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

/** `baseURL` is for c1's onboarding build. */
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
 * An allowlist on the AST, because the model wrote the spec after reading untrusted pages. Type annotations are
 * skipped (erased at runtime).
 *
 * This is defence in depth. Playwright's own API can still read local files and reach
 * the network, so the boundary is that the replay step holds no secrets: none in its env, none on
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

/** Replay counts a failed run as the bug only when it failed inside this step; a sign-in failure proves nothing. */
export const bugStep = 'bug check'

export const bugStepProblems = (source: string): string[] => {
  const isBugStep = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) &&
      node.expression.getText() === 'test.step' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === bugStep) ||
    ts.forEachChild(node, isBugStep) === true
  const sourceFile = ts.createSourceFile('repro.spec.ts', source, ts.ScriptTarget.Latest, true)
  return isBugStep(sourceFile) ? [] : [`no test.step('${bugStep}', …) holds the assertion`]
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

export const signature = (evidence: string) => normalize(evidence).slice(0, 200)

/** A visual finding keys on its function and element: its evidence is the model's own wording, which changes weekly. */
export const fingerprint = (finding: RawFinding) =>
  createHash('sha256')
    .update(
      finding.oracle.type === 'visual'
        ? `${finding.area}|visual|${finding.function ?? ''}|${signature(finding.element ?? '')}`
        : `${finding.area}|${finding.oracle.type}|${signature(finding.oracle.evidence)}`,
    )
    .digest('hex')
    .slice(0, 8)

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

type Ranked = Pick<RawFinding, 'area' | 'oracle'>

/** Console errors and layout overflows start Low and cannot be judged above Medium. */
const minor = ({ oracle: { type, evidence } }: Ranked) =>
  type === 'console-error' || (type === 'layout' && /\[qa-layout\] overflow-/.test(evidence))

/**
 * Severity from area and oracle type only: the anchor the judge's proposal is held to. An app that does not load
 * never reaches this table: the guard's smoke spec aborts the run first.
 */
export const severity = (finding: Ranked): Severity => {
  const { type } = finding.oracle
  if (minor(finding)) return 'Low'
  if (type === 'lost-on-reload' || (type === 'page-error' && finding.area === 'chat')) return 'Urgent'
  // Everything else, an AI reporting that a feature failed included, is a broken feature: its area decides.
  return areaSeverity[finding.area]
}

/** Most severe first by `severity`, so a cap that slices the result defers the least severe. Ties keep their order. */
export const mostSevereFirst = <T extends { finding: Ranked }>(files: T[]) =>
  files.toSorted((a, b) => severities.indexOf(severity(a.finding)) - severities.indexOf(severity(b.finding)))

/**
 * The judge's proposed priority, kept within one level of the table's and never above Medium for a console error
 * or an overflow. Without a proposal the table's value stands. The judge read untrusted pages, so its proposal only
 * nudges the table.
 */
export const judgedSeverity = (finding: Finding, proposed: Severity | undefined): Severity => {
  const table = severities.indexOf(severity(finding))
  const nudged = proposed ? severities.indexOf(proposed) : table
  const highest = minor(finding) ? Math.max(table - 1, severities.indexOf('Medium')) : table - 1
  return severities[Math.min(Math.max(nudged, highest), table + 1)]
}
