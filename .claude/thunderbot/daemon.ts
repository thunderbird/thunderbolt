import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { execSync, spawn } from 'child_process'
import type { DaemonState } from './types'

const STATE_DIR = join(process.env.HOME ?? '~', '.claude', 'thunderbot')
const STATE_FILE = join(STATE_DIR, 'daemon.state.json')
const PID_FILE = join(STATE_DIR, 'daemon.pid')
const LOG_FILE = join(STATE_DIR, 'daemon.log')
const POLL_INTERVAL_MS = 5 * 60 * 1000

const log = (message: string) => {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`
  process.stdout.write(line)
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG_FILE, line)
  } catch {
    // Best-effort logging
  }
}

const loadState = (): DaemonState => {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  }
  return { activeTasks: [], completedTasks: [], skippedTasks: [], lastPollAt: null }
}

const saveState = (state: DaemonState) => {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

const writePid = () => {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(PID_FILE, String(process.pid))
}

const clearPid = () => {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
}

const readPid = (): number | null => {
  if (!existsSync(PID_FILE)) return null
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
  return isNaN(pid) ? null : pid
}

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const commandExists = (cmd: string): boolean => {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const brewInstall = (formula: string, tap?: string): boolean => {
  if (!commandExists('brew')) {
    log(`Cannot auto-install "${formula}": Homebrew not found. Install from https://brew.sh`)
    return false
  }
  try {
    if (tap) {
      log(`Tapping ${tap}...`)
      execSync(`brew tap ${tap}`, { stdio: 'pipe' })
    }
    log(`Installing ${formula} via Homebrew...`)
    execSync(`brew install ${formula}`, { stdio: 'pipe' })
    return true
  } catch {
    log(`Failed to install ${formula}`)
    return false
  }
}

type Prerequisite = { cmd: string; formula: string; tap?: string; label: string }

const PREREQUISITES: Prerequisite[] = [
  { cmd: 'linear', formula: 'schpet/tap/linear', tap: 'schpet/tap', label: 'Linear CLI' },
  { cmd: 'gh', formula: 'gh', label: 'GitHub CLI' },
  { cmd: 'claude', formula: 'claude-code', label: 'Claude Code CLI' },
]

const ensurePrerequisites = (): boolean => {
  let allOk = true
  for (const { cmd, formula, tap, label } of PREREQUISITES) {
    if (commandExists(cmd)) continue
    log(`${label} ("${cmd}") not found. Attempting install...`)
    if (!brewInstall(formula, tap)) {
      log(`ERROR: ${label} is required but could not be installed.`)
      allOk = false
    } else {
      log(`${label} installed successfully.`)
    }
  }
  return allOk
}

const runCommand = (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.stderr.on('data', (d) => stderr.push(d))
    proc.on('error', (err) => {
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
      })
    })
    proc.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: code ?? 1,
      })
    })
  })
}

const pollAndWork = async (state: DaemonState) => {
  log('Polling Linear for unstarted tasks...')
  state.lastPollAt = new Date().toISOString()
  saveState(state)

  const { stdout, exitCode } = await runCommand('linear', ['issue', 'list', '--state', 'unstarted', '--sort', 'priority', '--json'])
  if (exitCode !== 0) {
    log('Failed to fetch issues from Linear')
    return
  }

  let issues: Array<{ identifier: string; title: string }>
  try {
    issues = JSON.parse(stdout)
  } catch {
    log('Failed to parse Linear output')
    return
  }

  const skipSet = new Set([...state.activeTasks, ...state.completedTasks, ...state.skippedTasks])
  const candidates = issues.filter((i) => !skipSet.has(i.identifier))

  if (candidates.length === 0) {
    log('No new candidate tasks found')
    return
  }

  const candidate = candidates[0]
  log(`Selected task: ${candidate.identifier} — ${candidate.title}`)

  state.activeTasks.push(candidate.identifier)
  saveState(state)

  log(`Spawning Claude Code for ${candidate.identifier}...`)
  const { exitCode: claudeExit, stderr: claudeErr } = await runCommand('claude', [
    '--print',
    '--dangerously-skip-permissions',
    '-p',
    `/thunderbot ${candidate.identifier}`,
  ])

  state.activeTasks = state.activeTasks.filter((t) => t !== candidate.identifier)

  if (claudeExit === 0) {
    state.completedTasks.push(candidate.identifier)
    log(`Completed task: ${candidate.identifier}`)
  } else {
    state.skippedTasks.push(candidate.identifier)
    log(`Failed task: ${candidate.identifier} (exit ${claudeExit})`)
    if (claudeErr) log(`stderr: ${claudeErr.slice(0, 500)}`)
  }

  saveState(state)
}

const startDaemon = async () => {
  const existingPid = readPid()
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Daemon already running (PID ${existingPid})`)
    process.exit(1)
  }

  if (!ensurePrerequisites()) {
    console.error('Missing required tools. Install them and try again.')
    process.exit(1)
  }

  writePid()
  log('Daemon started')

  const shutdown = () => {
    log('Daemon shutting down')
    clearPid()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const state = loadState()

  const poll = async () => {
    await pollAndWork(state)
    setTimeout(poll, POLL_INTERVAL_MS)
  }
  await poll()
}

const stopDaemon = () => {
  const pid = readPid()
  if (!pid) {
    console.log('No daemon running')
    return
  }
  if (!isProcessRunning(pid)) {
    console.log(`Stale PID file (process ${pid} not running). Cleaning up.`)
    clearPid()
    return
  }
  process.kill(pid, 'SIGTERM')
  console.log(`Sent SIGTERM to daemon (PID ${pid})`)
}

const showStatus = () => {
  const pid = readPid()
  const running = pid && isProcessRunning(pid)
  const state = loadState()

  console.log(`Daemon: ${running ? `running (PID ${pid})` : 'stopped'}`)
  console.log(`Last poll: ${state.lastPollAt ?? 'never'}`)
  console.log(`Active: ${state.activeTasks.length} task(s)`)
  console.log(`Completed: ${state.completedTasks.length} task(s)`)
  console.log(`Skipped: ${state.skippedTasks.length} task(s)`)

  const missing = PREREQUISITES.filter((p) => !commandExists(p.cmd))
  if (missing.length > 0) {
    console.log(`\nMissing tools: ${missing.map((p) => p.label).join(', ')}`)
    console.log(`Run "/thunderbot-daemon start" to auto-install, or: bash .claude/thunderbot/setup.sh`)
  }

  if (existsSync(LOG_FILE)) {
    console.log(`\nRecent logs:`)
    const lines = readFileSync(LOG_FILE, 'utf-8').trim().split('\n')
    console.log(lines.slice(-10).join('\n'))
  }
}

// CLI entrypoint
const command = process.argv[2]

switch (command) {
  case 'start':
    await startDaemon()
    break
  case 'stop':
    stopDaemon()
    break
  case 'status':
    showStatus()
    break
  default:
    console.log('Usage: bun daemon.ts [start|stop|status]')
    process.exit(1)
}
