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
}

/** Move cursor to absolute row, col */
const moveTo = (row: number, col = 1) => write(`\x1b[${row};${col}H`)

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const fixedBaseLines = 3 // separator + progress + stats
const headerLines = 5 // title + separator + info + separator + blank
const barWidth = 30
const promptMaxWidth = 48
const idWidth = 18

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
  // Deliberately NOT silencing console.error — errors should always surface
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
let maxSpinners = 1

// Active spinners: scenario.id → { scenario, startTime }
const activeSpinners = new Map<string, { scenario: EvalScenario; startTime: number }>()

// Accumulated result lines for the middle area (rolling display)
const resultLines: string[] = []

const fixedBottomLines = () => fixedBaseLines + maxSpinners
const resultsHeight = () => termRows() - headerLines - fixedBottomLines()

// ── Layout setup ───────────────────────────────────────────

/** Initialize the terminal layout: fixed header, rolling results, fixed footer */
export const initLayout = (scenarios: EvalScenario[], concurrency: number) => {
  totalScenarios = scenarios.length
  evalStartTime = performance.now()
  maxSpinners = concurrency

  // Clear screen and render header
  write('\x1b[2J') // clear screen
  write('\x1b[?25l') // hide cursor
  moveTo(1, 1)

  write(`  ${esc.bold}Thunderbolt AI Eval${esc.reset}\n`)
  write(`  ${esc.gray}${'━'.repeat(Math.min(52, termCols() - 4))}${esc.reset}\n`)

  const models = [...new Set(scenarios.map((s) => s.modelName))].join(', ')
  const modes = [...new Set(scenarios.map((s) => s.modeName))].join(', ')
  write(`  ${esc.dim}Models: ${models} · Modes: ${modes} · ${scenarios.length} scenarios${esc.reset}\n`)
  write(`  ${esc.gray}${'━'.repeat(Math.min(52, termCols() - 4))}${esc.reset}\n`)

  // Draw initial footer
  renderFooter()
}

/** Clean up: show cursor and move to end */
export const teardownLayout = () => {
  stopAllSpinners()
  write('\x1b[?25h') // show cursor
  moveTo(termRows(), 1)
  write('\n')
}

// ── Results area (middle) ──────────────────────────────────

const renderResults = () => {
  const height = resultsHeight()
  const startRow = headerLines + 1
  const visible = resultLines.slice(-height)

  for (let i = 0; i < height; i++) {
    moveTo(startRow + i, 1)
    write(esc.clearLine)
    if (i < visible.length) {
      write(visible[i])
    }
  }
}

// ── Fixed footer rendering ─────────────────────────────────

const renderFooter = () => {
  const rows = termRows()
  const cols = termCols()
  const pct = totalScenarios === 0 ? 0 : Math.round((completedCount / totalScenarios) * 100)
  const filled = totalScenarios === 0 ? 0 : Math.round((completedCount / totalScenarios) * barWidth)
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled)
  const elapsed = ((performance.now() - evalStartTime) / 1000).toFixed(0)
  const baseRow = rows - fixedBottomLines() + 1

  // Row 1: separator
  moveTo(baseRow, 1)
  write(`${esc.clearLine}  ${esc.gray}${'─'.repeat(Math.min(52, cols - 4))}${esc.reset}`)

  // Row 2: progress bar
  moveTo(baseRow + 1, 1)
  write(`${esc.clearLine}  Progress ${esc.cyan}${bar}${esc.reset} ${pct}%  (${completedCount}/${totalScenarios})`)

  // Row 3: stats
  moveTo(baseRow + 2, 1)
  const failStr = failedCount > 0 ? `${esc.red}Failed: ${failedCount}${esc.reset}` : `${esc.dim}Failed: 0${esc.reset}`
  write(
    `${esc.clearLine}  ${esc.green}Passed: ${passedCount}${esc.reset}  ${failStr}  ${esc.gray}Elapsed: ${elapsed}s${esc.reset}`,
  )

  // Rows 4+: spinner rows
  const frame = spinnerFrames[spinnerFrame % spinnerFrames.length]
  const activeList = [...activeSpinners.values()]

  for (let i = 0; i < maxSpinners; i++) {
    moveTo(baseRow + 3 + i, 1)
    const entry = activeList[i]
    if (entry) {
      const idShort = truncate(entry.scenario.id, idWidth)
      const promptShort = truncate(entry.scenario.prompt, promptMaxWidth)
      const spinElapsed = ((performance.now() - entry.startTime) / 1000).toFixed(0)
      write(
        `${esc.clearLine}  ${esc.yellow}${frame}${esc.reset} ${esc.dim}${idShort}${esc.reset}  ${promptShort}  ${esc.gray}[${spinElapsed}s]${esc.reset}`,
      )
    } else {
      write(esc.clearLine)
    }
  }
}

// ── Public API ─────────────────────────────────────────────

export const startSpinner = (scenario: EvalScenario) => {
  activeSpinners.set(scenario.id, { scenario, startTime: performance.now() })

  if (!spinnerInterval) {
    spinnerInterval = setInterval(() => {
      spinnerFrame++
      renderFooter()
    }, 80)
  }

  renderFooter()
}

export const stopSpinner = (scenarioId: string) => {
  activeSpinners.delete(scenarioId)

  if (activeSpinners.size === 0 && spinnerInterval) {
    clearInterval(spinnerInterval)
    spinnerInterval = null
    renderFooter()
  }
}

const stopAllSpinners = () => {
  if (spinnerInterval) {
    clearInterval(spinnerInterval)
    spinnerInterval = null
  }
  activeSpinners.clear()
}

export const printResult = (result: EvalResult) => {
  completedCount++
  if (result.passed) passedCount++
  else failedCount++

  const id = truncate(result.scenario.id, idWidth)
  const promptShort = truncate(result.scenario.prompt, promptMaxWidth)
  const time = `${(result.durationMs / 1000).toFixed(1)}s`

  const icon = result.passed ? `${esc.green}✓${esc.reset}` : `${esc.red}✗${esc.reset}`

  const metrics: string[] = []
  if (result.citations.length > 0)
    metrics.push(`${result.citations.length} cite${result.citations.length !== 1 ? 's' : ''}`)
  if (result.widgets.length > 0)
    metrics.push(`${result.widgets.length} widget${result.widgets.length !== 1 ? 's' : ''}`)
  if (result.linkPreviewUrls.length > 0) metrics.push(`${result.linkPreviewUrls.length} links`)
  const metricsStr = metrics.length > 0 ? `  ${esc.dim}${metrics.join('  ')}${esc.reset}` : ''

  // Push result line
  resultLines.push(
    `  ${icon} ${esc.dim}${id.padEnd(idWidth)}${esc.reset} ${promptShort.padEnd(promptMaxWidth)}  ${esc.gray}${time.padStart(6)}${esc.reset}${metricsStr}`,
  )

  // Push failure lines
  if (!result.passed && result.failures.length > 0) {
    for (const failure of result.failures) {
      resultLines.push(`  ${' '.repeat(idWidth + 3)}${esc.red}↳ ${failure}${esc.reset}`)
    }
  }

  // Re-render the results area and footer
  renderResults()
  renderFooter()
}

export const printFooter = () => {
  stopAllSpinners()
  renderFooter()
}

// ── Helpers ────────────────────────────────────────────────

const truncate = (text: string, maxLen: number) => (text.length <= maxLen ? text : text.substring(0, maxLen - 1) + '…')
