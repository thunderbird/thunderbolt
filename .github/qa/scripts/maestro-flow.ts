/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

/**
 * Nothing else from the caller's environment reaches Maestro. The gate's `maestro mcp` and the replay's
 * `maestro test` also get the MCP SDK's default HOME, LOGNAME, PATH, SHELL, TERM and USER.
 */
export const maestroEnv = () => ({
  ...Object.fromEntries(
    ['JAVA_HOME', 'ANDROID_HOME'].flatMap((key) => {
      const value = process.env[key]
      return value ? [[key, value]] : []
    }),
  ),
  MAESTRO_CLI_NO_ANALYTICS: '1',
  // Its "Analyze with AI" banner otherwise fills the output a failed run's error is cut from.
  MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
  MAESTRO_DRIVER_STARTUP_TIMEOUT: '180000',
})

/** The only variable a flow may use: a fresh sign-in address per run. */
export const flowVars = ['EMAIL']

export type FlowCheck = { ok: true; yaml: string } | { ok: false; problems: string[] }

const bareCommands = [
  'eraseText',
  'hideKeyboard',
  'inputRandomEmail',
  'inputRandomPersonName',
  'inputRandomNumber',
  'inputRandomText',
  'scroll',
  'waitForAnimationToEnd',
  'back',
  'launchApp',
  'stopApp',
  'killApp',
] as const
const variable = /^\$\{([A-Za-z_]\w*)\}$/
const percent = /^\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*$/
const coordinates = (point: string) => (percent.exec(point) ?? []).slice(1).map(Number)

// The commands after which the app is no longer in front (Android's back leaves it at the root), and the one that
// brings it back. The gate checks the foreground only once a flow has ended, so nothing may run in between.
const appRef = z.union([z.string(), z.object({})])
const stop = z.union([z.enum(['stopApp', 'killApp']), z.object({ stopApp: appRef }), z.object({ killApp: appRef })])
const relaunch = z.union([
  z.literal('launchApp'),
  z.object({ launchApp: z.union([z.string(), z.object({ optional: z.literal(false).optional() })]) }),
])
const back = z.union([
  z.literal('back'),
  z.object({ back: z.object({}) }),
  z.object({ pressKey: z.union([z.literal('Back'), z.object({ key: z.literal('Back') })]) }),
])

/** Maestro's GraalJS can make HTTP calls and send any readable file, so what is not listed is refused. */
const flowSchemas = (appId: string, vars: string[]) => {
  const text = z
    .string({ error: 'expected text' })
    .refine((value) => !value.includes('${') || vars.includes(variable.exec(value)?.[1] ?? ''), {
      error: `\${ is allowed only as \${NAME} of a harness variable (${vars.join(', ') || 'none'})`,
    })
  const whole = (max: number) => {
    const error = `expected a whole number from 0 to ${max}`
    return z.int({ error }).min(0, { error }).max(max, { error })
  }
  const ms = whole(120000)
  const count = whole(10)
  const int = whole(10000)
  const bool = z.boolean({ error: 'expected true or false' })
  const oneOf = (values: readonly [string, ...string[]]) =>
    z.enum(values, { error: `expected one of ${values.join(', ')}` })
  const direction = oneOf(['UP', 'DOWN', 'LEFT', 'RIGHT'])
  const key = oneOf(['Enter', 'Backspace', 'Back', 'Tab', 'Escape'])
  const ourAppId = z.literal(appId, { error: `only ${appId} is allowed` })
  const options = (fields: Record<string, z.ZodType>) =>
    z.strictObject({ label: text, optional: bool, ...fields }, { error: 'expected a mapping' }).partial()
  const shortOr = (short: z.ZodType, fields: Record<string, z.ZodType>) =>
    z.union([short, options(fields)], { error: 'expected a value or a mapping' })

  // Pixels cannot be checked without the screen size, so points are percentages. A tap or a swipe at an edge is a
  // system control or gesture (Notification and Control Center, home, Android back, Home and Recents) that leaves
  // our app.
  const percentPoint = z
    .string()
    .regex(percent, { error: 'expected a point in percent, like 50%, 40%' })
    .refine((value) => coordinates(value).every((n) => n <= 100), { error: 'percentages go up to 100' })
  const awayFromEdges = percentPoint.refine((value) => coordinates(value).every((n) => n >= 5 && n <= 95), {
    error: 'a point may not lie within 5% of a screen edge',
  })

  const nested = z.lazy(() => selector)
  const selectorFields = {
    text,
    id: text,
    index: int,
    point: awayFromEdges,
    enabled: bool,
    selected: bool,
    checked: bool,
    focused: bool,
    below: nested,
    above: nested,
    leftOf: nested,
    rightOf: nested,
    childOf: nested,
    containsChild: nested,
    containsDescendants: z.array(nested, { error: 'expected a list' }),
    width: int,
    height: int,
    tolerance: int,
    traits: oneOf(['TEXT', 'SQUARE', 'LONG_TEXT']),
    retryTapIfNoChange: bool,
    waitUntilVisible: bool,
    repeat: count,
    delay: ms,
    waitToSettleTimeoutMs: ms,
  }
  const selector: z.ZodType = z.union(
    [text, z.strictObject(selectorFields, { error: 'expected a mapping' }).partial()],
    {
      error: 'expected text or a selector mapping',
    },
  )
  const tap = shortOr(text, selectorFields)
  const when = z
    .strictObject(
      { visible: selector, notVisible: selector, platform: oneOf(['Android', 'iOS']) },
      { error: 'expected a mapping' },
    )
    .partial()
  const ordered = (item: z.ZodType, topLevel: boolean) =>
    z.array(item, { error: 'expected a list of commands' }).superRefine((items, ctx) =>
      items.forEach((entry, index) => {
        // The last command of the whole flow may leave the app: the gate checks the foreground right after it.
        if (topLevel && index === items.length - 1) return
        if (stop.safeParse(entry).success && !relaunch.safeParse(items[index + 1]).success) {
          ctx.addIssue({ code: 'custom', path: [index], message: 'stopApp and killApp must be followed by launchApp' })
        }
        if (back.safeParse(entry).success) {
          ctx.addIssue({ code: 'custom', path: [index], message: 'back may only be the last command of the flow' })
        }
      }),
    )
  const commands: z.ZodType = z.lazy(() => ordered(command, false))
  const loopCommands: z.ZodType = z.lazy(() => ordered(loopCommand, false))
  const app = shortOr(ourAppId, { appId: ourAppId })
  const commandItem = (flowControl: Record<string, z.ZodType>) =>
    z.union(
      [
        z.enum(bareCommands, { error: (issue) => `${String(issue.input)} is not a command allowed without a value` }),
        z
          .strictObject(
            {
              tapOn: tap,
              doubleTapOn: tap,
              longPressOn: tap,
              assertVisible: tap,
              assertNotVisible: tap,
              inputText: shortOr(text, { text }),
              eraseText: shortOr(int, { charactersToErase: int }),
              hideKeyboard: options({}),
              inputRandomEmail: options({}),
              inputRandomPersonName: options({}),
              inputRandomNumber: options({ length: int }),
              inputRandomText: options({ length: int }),
              scroll: options({}),
              scrollUntilVisible: options({
                element: selector,
                direction,
                timeout: ms,
                speed: int,
                visibilityPercentage: int,
                centerElement: bool,
                waitToSettleTimeoutMs: ms,
              }),
              swipe: options({
                direction,
                start: awayFromEdges,
                end: percentPoint,
                from: selector,
                duration: ms,
                waitToSettleTimeoutMs: ms,
              }).refine((swipe) => 'start' in swipe === 'end' in swipe, {
                error: 'a swipe needs both start and end, or neither',
              }),
              extendedWaitUntil: options({ visible: selector, notVisible: selector, timeout: ms }),
              waitForAnimationToEnd: options({ timeout: ms }),
              back: options({}),
              pressKey: shortOr(key, { key }),
              launchApp: shortOr(ourAppId, { appId: ourAppId, stopApp: bool }),
              stopApp: app,
              killApp: app,
              ...flowControl,
            },
            { error: 'expected a command name or a mapping' },
          )
          .partial()
          .refine((item) => Object.keys(item).length === 1, { error: 'expected one command per item' }),
      ],
      { error: 'expected a command name or a mapping' },
    )
  // Maestro 2.11 repeats up to Int.MAX_VALUE times without `times`, and nested loops multiply. A `retry` without
  // `maxRetries` retries once, and Maestro caps it at 3.
  const command = commandItem({
    repeat: options({ while: when, commands: loopCommands }).extend({ times: count }),
    retry: options({ maxRetries: count, commands: loopCommands }),
    runFlow: options({ when, commands }),
  })
  const nestedLoop = z.never({ error: 'repeat and retry cannot be nested inside repeat or retry' })
  const loopCommand = commandItem({
    repeat: nestedLoop,
    retry: nestedLoop,
    runFlow: options({ when, commands: loopCommands }),
  })
  const header = z.strictObject({ appId: ourAppId, name: text }, { error: 'expected a mapping' }).partial().nullable()
  return { header, commands: z.lazy(() => ordered(command, true)) }
}

const isTypeMismatch = (branch: z.core.$ZodIssue[]) =>
  branch.length === 1 && branch[0].path.length === 0 && ['invalid_type', 'invalid_value'].includes(branch[0].code)

/** A union reports the branch the value was written for, so a mapping gets its key problems, not "expected text". */
const describeIssues = (issues: z.core.$ZodIssue[], prefix: string): string[] =>
  issues.flatMap((issue) => {
    const path =
      prefix + issue.path.map((key) => (Number.isInteger(key) ? `[${String(key)}]` : `.${String(key)}`)).join('')
    if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => `${path}.${key}: key not allowed`)
    if (issue.code !== 'invalid_union') return [`${path}: ${issue.message}`]
    const fitting = issue.errors.filter((branch) => !isTypeMismatch(branch))
    const named = issue.errors.filter((branch) => branch[0]?.code === 'invalid_value')
    const branches = fitting.length > 0 ? fitting : named
    return branches.length > 0
      ? branches.flatMap((branch) => describeIssues(branch, path))
      : [`${path}: ${issue.message}`]
  })

/**
 * Refuses YAML features before parsing, because `Bun.YAML.parse` resolves anchors, aliases and merge keys silently.
 * A token counts only where a YAML node starts (line start, after `- `, `: `, `,`, `[` or `{`), so plain text such as
 * `Terms & Conditions` or the regex `.*` passes. Quoted text must stay on one line and block scalars are refused, so
 * a misread quote can never hide the rest of the flow from this scan.
 */
const rawProblem = (source: string): string | undefined => {
  if (/^(\.\.\.|%)/m.test(source)) return 'document end markers (...) and directives (%) are not allowed'
  if (/^---(?![ \t]*$)/m.test(source)) return 'a document marker (---) must stand alone on its line'
  const blank = ' \t\n'
  let line = 1
  let quote = ''
  let quoteStart = 0
  let node = true
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    const at = `line ${line}`
    if (quote) {
      if (quote === '"' && c === '\\') {
        i++
        if (source[i] === '\n') return `${at}: quoted text must stay on one line`
        continue
      }
      if (c === '\n') return `${at}: quoted text must stay on one line`
      if (c !== quote) continue
      if (quote === "'" && source[i + 1] === "'") {
        i++
        continue
      }
      // Bun treats a quoted "<<" key as a merge key too.
      if (source.slice(quoteStart, i) === '<<' && /^[ \t]*:/.test(source.slice(i + 1))) {
        return `${at}: merge keys (<<) are not allowed`
      }
      quote = ''
      node = false
      continue
    }
    if (c === '\n') {
      line++
      node = true
      continue
    }
    if (blank.includes(c)) continue
    if (c === '#' && (i === 0 || blank.includes(source[i - 1]))) {
      const end = source.indexOf('\n', i)
      if (end === -1) break
      i = end - 1
      continue
    }
    if (!node) {
      node = ':,[{'.includes(c)
      continue
    }
    const next = source[i + 1] ?? '\n'
    if (c === '&' || c === '*') return `${at}: anchors and aliases are not allowed`
    if (c === '!') return `${at}: tags are not allowed`
    if (c === '|' || c === '>') return `${at}: block scalars are not allowed`
    if (c === '<' && next === '<') return `${at}: merge keys (<<) are not allowed`
    if (c === '"' || c === "'") {
      quote = c
      quoteStart = i + 1
      continue
    }
    node = ':,[{'.includes(c) || ('-?'.includes(c) && blank.includes(next))
  }
  return undefined
}

const parseDocuments = (documents: string[]) => {
  try {
    return { values: documents.map((document) => Bun.YAML.parse(document)) }
  } catch (error) {
    return { problem: `not valid YAML: ${String(error)}` }
  }
}

/** Maestro only sees what this function wrote, never the input. `vars` are the names a `${NAME}` may use. */
export const checkMaestroFlow = (input: string, options: { appId: string; vars?: string[] }): FlowCheck => {
  // Bun reads a lone \r as a line break, so the scan must see the same lines.
  const source = input.replace(/\r\n?/g, '\n')
  const raw = rawProblem(source)
  if (raw) return { ok: false, problems: [raw] }
  const parts = source.split(/^---[ \t]*$/m)
  const documents = parts.length > 1 && !parts[0].trim() ? parts.slice(1) : parts
  if (documents.length > 2) return { ok: false, problems: ['more than two YAML documents'] }
  const parsed = parseDocuments(documents)
  if (parsed.problem !== undefined) return { ok: false, problems: [parsed.problem] }
  const [header, commands] = parsed.values.length === 2 ? parsed.values : [null, parsed.values[0]]
  const schemas = flowSchemas(options.appId, options.vars ?? [])
  const headerResult = schemas.header.safeParse(header)
  const commandsResult = schemas.commands.safeParse(commands)
  const problems = [
    ...describeIssues(headerResult.error?.issues ?? [], 'header'),
    ...describeIssues(commandsResult.error?.issues ?? [], 'commands'),
  ]
  if (!headerResult.success || !commandsResult.success) return { ok: false, problems }
  return { ok: true, yaml: `appId: ${options.appId}\n---\n${Bun.YAML.stringify(commandsResult.data, null, 2)}` }
}
