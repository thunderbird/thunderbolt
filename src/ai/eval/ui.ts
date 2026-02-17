import type { EvalResult, EvalScenario } from './types'

const write = (text: string) => process.stdout.write(text)

// ── ANSI escape codes ──────────────────────────────────────
const esc = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  clearLine: '\x1b[2K',
  saveCursor: '\x1b[s',
  restoreCursor: '\x1b[u',
}

/** Move cursor to absolute row, col */
const moveTo = (row: number, col = 1) => write(`\x1b[${row};${col}H`)

/** Set scroll region (rows top..bottom scroll, rest is fixed) */
const setScrollRegion = (top: number, bottom: number) => write(`\x1b[${top};${bottom}r`)

/** Reset scroll region to full terminal */
const resetScrollRegion = () => write('\x1b[r')

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FIXED_BOTTOM_LINES = 4 // separator + progress + stats + spinner
const BAR_WIDTH = 30
const PROMPT_MAX_WIDTH = 48

const termRows = () => process.stdout.rows || 40
const termCols = () => process.stdout.columns || 80

// ── Console suppression ────────────────────────────────────
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  groupCollapsed: console.groupCollapsed,
  groupEnd: console.groupEnd,
}

export const silenceConsole = () => {
  const noop = () => {}
  console.log = noop
  console.info = noop
  console.warn = noop
  console.groupCollapsed = noop
  console.groupEnd = noop
}

export const restoreConsole = () => {
  Object.assign(console, originalConsole)
}

// ── State ──────────────────────────────────────────────────
let totalScenarios = 0
let completedCount = 0
let passedCount = 0
let failedCount = 0
let evalStartTime = 0
let spinnerInterval: ReturnType<typeof setInterval> | null = null
let spinnerFrame = 0
let spinnerStartTime = 0
let currentSpinnerScenario: EvalScenario | null = null

// ── Layout setup ───────────────────────────────────────────

/** Initialize the terminal layout: scrollable top area + fixed bottom */
export const initLayout = (scenarios: EvalScenario[]) => {
  totalScenarios = scenarios.length
  evalStartTime = performance.now()

  const rows = termRows()
  const scrollBottom = rows - FIXED_BOTTOM_LINES

  // Clear screen and set scroll region
  write('\x1b[2J') // clear screen
  moveTo(1, 1)

  // Print header in the scroll region
  write(`  ${esc.bold}Thunderbolt AI Eval${esc.reset}\n`)
  write(`  ${esc.gray}${'━'.repeat(Math.min(52, termCols() - 4))}${esc.reset}\n`)

  const models = [...new Set(scenarios.map((s) => s.modelName))].join(', ')
  const modes = [...new Set(scenarios.map((s) => s.modeName))].join(', ')
  write(`  ${esc.dim}Models: ${models} · Modes: ${modes} · ${scenarios.length} scenarios${esc.reset}\n`)
  write(`  ${esc.gray}${'━'.repeat(Math.min(52, termCols() - 4))}${esc.reset}\n\n`)

  // Set scroll region (header + results area, excluding bottom fixed lines)
  setScrollRegion(1, scrollBottom)

  // Draw initial fixed bottom
  renderFixedBottom()
}

/** Clean up: reset scroll region and move cursor to end */
export const teardownLayout = () => {
  stopSpinner()
  resetScrollRegion()
  const rows = termRows()
  moveTo(rows, 1)
  write('\n')
}

// ── Fixed bottom rendering ─────────────────────────────────

const renderFixedBottom = () => {
  const rows = termRows()
  const cols = termCols()
  const pct = totalScenarios === 0 ? 0 : Math.round((completedCount / totalScenarios) * 100)
  const filled = totalScenarios === 0 ? 0 : Math.round((completedCount / totalScenarios) * BAR_WIDTH)
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
  const elapsed = ((performance.now() - evalStartTime) / 1000).toFixed(0)

  // Save cursor position in scroll region
  write(esc.saveCursor)

  // Row 1: separator
  moveTo(rows - 3, 1)
  write(`${esc.clearLine}  ${esc.gray}${'─'.repeat(Math.min(52, cols - 4))}${esc.reset}`)

  // Row 2: progress bar
  moveTo(rows - 2, 1)
  write(`${esc.clearLine}  Progress ${esc.cyan}${bar}${esc.reset} ${pct}%  (${completedCount}/${totalScenarios})`)

  // Row 3: stats
  moveTo(rows - 1, 1)
  const failStr = failedCount > 0 ? `${esc.red}Failed: ${failedCount}${esc.reset}` : `${esc.dim}Failed: 0${esc.reset}`
  write(
    `${esc.clearLine}  ${esc.green}Passed: ${passedCount}${esc.reset}  ${failStr}  ${esc.gray}Elapsed: ${elapsed}s${esc.reset}`,
  )

  // Row 4: spinner (current scenario)
  moveTo(rows, 1)
  if (currentSpinnerScenario) {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]
    const id = currentSpinnerScenario.id.split('/').pop() ?? currentSpinnerScenario.id
    const promptShort = truncate(currentSpinnerScenario.prompt, PROMPT_MAX_WIDTH)
    const spinElapsed = ((performance.now() - spinnerStartTime) / 1000).toFixed(0)
    write(
      `${esc.clearLine}  ${esc.yellow}${frame}${esc.reset} ${esc.dim}${id}${esc.reset}  ${promptShort}  ${esc.gray}[${spinElapsed}s]${esc.reset}`,
    )
  } else {
    write(esc.clearLine)
  }

  // Restore cursor to scroll region
  write(esc.restoreCursor)
}

// ── Public API ─────────────────────────────────────────────

export const printModelSection = (modelName: string, count: number) => {
  write(`\n  ${esc.bold}${modelName.toUpperCase()}${esc.reset} ${esc.dim}(${count} scenarios)${esc.reset}\n\n`)
}

export const startSpinner = (scenario: EvalScenario) => {
  currentSpinnerScenario = scenario
  spinnerStartTime = performance.now()
  spinnerFrame = 0

  renderFixedBottom()
  spinnerInterval = setInterval(() => {
    spinnerFrame++
    renderFixedBottom()
  }, 80)
}

export const stopSpinner = () => {
  if (spinnerInterval) {
    clearInterval(spinnerInterval)
    spinnerInterval = null
  }
  currentSpinnerScenario = null
}

export const printResult = (result: EvalResult) => {
  completedCount++
  if (result.passed) passedCount++
  else failedCount++

  const id = result.scenario.id.split('/').pop() ?? result.scenario.id
  const promptShort = truncate(result.scenario.prompt, PROMPT_MAX_WIDTH)
  const time = `${(result.durationMs / 1000).toFixed(1)}s`

  const icon = result.passed ? `${esc.green}✓${esc.reset}` : `${esc.red}✗${esc.reset}`

  const metrics: string[] = []
  if (result.citations.length > 0)
    metrics.push(`${result.citations.length} cite${result.citations.length !== 1 ? 's' : ''}`)
  if (result.widgets.length > 0)
    metrics.push(`${result.widgets.length} widget${result.widgets.length !== 1 ? 's' : ''}`)
  if (result.linkPreviewUrls.length > 0) metrics.push(`${result.linkPreviewUrls.length} links`)
  const metricsStr = metrics.length > 0 ? `  ${esc.dim}${metrics.join('  ')}${esc.reset}` : ''

  // Print main result line
  write(
    `  ${icon} ${esc.dim}${id.padEnd(4)}${esc.reset} ${promptShort.padEnd(PROMPT_MAX_WIDTH)}  ${esc.gray}${time.padStart(6)}${esc.reset}${metricsStr}\n`,
  )

  // Print failure reasons on a separate indented line for readability
  if (!result.passed && result.failures.length > 0) {
    for (const failure of result.failures) {
      write(`         ${esc.red}↳ ${failure}${esc.reset}\n`)
    }
  }

  // Update fixed bottom
  renderFixedBottom()
}

export const printFooter = () => {
  // Final render of bottom with no spinner
  stopSpinner()
  renderFixedBottom()
}

// ── Helpers ────────────────────────────────────────────────

const truncate = (text: string, maxLen: number) => (text.length <= maxLen ? text : text.substring(0, maxLen - 1) + '…')
