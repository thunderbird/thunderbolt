/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import type { DaemonState } from './types'
import { priorityLabels } from './assess'

const stateDir = join(homedir(), '.claude', 'thunderbot')
const stateFile = join(stateDir, 'daemon.state.json')
const pidFile = join(stateDir, 'daemon.pid')
const logFile = join(stateDir, 'daemon.log')
const pollIntervalMs = 5 * 60 * 1000
const maxHistorySize = 200

// Ensure state directory exists once at module load
mkdirSync(stateDir, { recursive: true })

const log = (message: string) => {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`
  process.stdout.write(line)
  try {
    appendFileSync(logFile, line)
  } catch {
    // Best-effort logging
  }
}

const defaultState = (): DaemonState => ({ activeTasks: [], completedTasks: [], skippedTasks: [], lastPollAt: null })

const loadState = (): DaemonState => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf-8'))
  } catch {
    return defaultState()
  }
}

const saveState = (state: DaemonState) => {
  // Write a copy with capped arrays so in-memory state isn't mutated if the write fails
  const toWrite: DaemonState = {
    ...state,
    completedTasks: state.completedTasks.length > maxHistorySize ? state.completedTasks.slice(-maxHistorySize) : state.completedTasks,
    skippedTasks: state.skippedTasks.length > maxHistorySize ? state.skippedTasks.slice(-maxHistorySize) : state.skippedTasks,
  }
  writeFileSync(stateFile, JSON.stringify(toWrite, null, 2))
  // Only truncate in-memory state after a successful write
  state.completedTasks = toWrite.completedTasks
  state.skippedTasks = toWrite.skippedTasks
}

const writePid = () => {
  writeFileSync(pidFile, String(process.pid))
}

const clearPid = () => {
  try {
    unlinkSync(pidFile)
  } catch {
    // Already gone
  }
}

const readPid = (): number | null => {
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const commandExists = (cmd: string): boolean =>
  spawnSync('command', ['-v', cmd], { stdio: 'pipe', shell: true }).status === 0

const brewInstall = (formula: string, tap?: string): boolean => {
  if (!commandExists('brew')) {
    log(`Cannot auto-install "${formula}": Homebrew not found. Install from https://brew.sh`)
    return false
  }
  try {
    if (tap) {
      log(`Tapping ${tap}...`)
      const tapResult = spawnSync('brew', ['tap', tap], { stdio: 'pipe' })
      if (tapResult.status !== 0) {
        throw new Error(`brew tap failed`)
      }
    }
    log(`Installing ${formula} via Homebrew...`)
    const installResult = spawnSync('brew', ['install', formula], { stdio: 'pipe' })
    if (installResult.status !== 0) {
      throw new Error(`brew install failed`)
    }
    return true
  } catch {
    log(`Failed to install ${formula}`)
    return false
  }
}

type Prerequisite = { cmd: string; formula: string; tap?: string; label: string }

const prerequisites: Prerequisite[] = [
  { cmd: 'linear', formula: 'schpet/tap/linear', tap: 'schpet/tap', label: 'Linear CLI' },
  { cmd: 'gh', formula: 'gh', label: 'GitHub CLI' },
  { cmd: 'claude', formula: 'claude-code', label: 'Claude Code CLI' },
]

const ensurePrerequisites = (): boolean =>
  prerequisites.every(({ cmd, formula, tap, label }) => {
    if (commandExists(cmd)) {
      return true
    }
    log(`${label} ("${cmd}") not found. Attempting install...`)
    if (!brewInstall(formula, tap)) {
      log(`ERROR: ${label} is required but could not be installed.`)
      return false
    }
    log(`${label} installed successfully.`)
    return true
  })

// Track the active child process so it can be terminated on daemon shutdown
let activeChild: ChildProcess | null = null

const runCommand = (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    activeChild = proc
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.stderr.on('data', (d) => stderr.push(d))
    proc.on('error', (err) => {
      activeChild = null
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
      })
    })
    proc.on('close', (code) => {
      activeChild = null
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

  const { stdout, exitCode } = await runCommand('linear', ['issue', 'list', '--team', 'THU', '--state', 'unstarted', '--all-assignees', '--sort', 'priority'])
  if (exitCode !== 0) {
    log('Failed to fetch issues from Linear')
    return
  }

  // linear issue list outputs a human-readable table — parse identifiers from it
  const issues: Array<{ identifier: string; title: string; goodForBot: boolean }> = []
  for (const line of stdout.split('\n')) {
    const match = line.match(/\b(THU-\d+)\b\s+(.+?)(?:\s{2,}|$)/)
    if (match) {
      const lineLower = line.toLowerCase()
      issues.push({ identifier: match[1], title: match[2].trim(), goodForBot: priorityLabels.some((label) => lineLower.includes(label)) })
    }
  }

  const skipSet = new Set([...state.activeTasks, ...state.completedTasks, ...state.skippedTasks])
  const candidates = issues.filter((i) => !skipSet.has(i.identifier))

  if (candidates.length === 0) {
    log('No new candidate tasks found')
    return
  }

  // Prioritize tasks labeled "Good For Bot" before falling back to priority order
  const goodForBotCandidates = candidates.filter((c) => c.goodForBot)
  const candidate = goodForBotCandidates.length > 0 ? goodForBotCandidates[0] : candidates[0]
  if (goodForBotCandidates.length > 0) {
    log(`Found ${goodForBotCandidates.length} "Good For Bot" task(s) — prioritizing`)
  }
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
    if (claudeErr) {
      log(`stderr: ${claudeErr.slice(0, 500)}`)
    }
  }

  saveState(state)
}

const startDaemon = async () => {
  const existingPid = readPid()
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Daemon already running (PID ${existingPid})`)
    process.exit(0)
  }

  if (!ensurePrerequisites()) {
    console.error('Missing required tools. Install them and try again.')
    process.exit(1)
  }

  writePid()
  log('Daemon started')

  const state = loadState()

  // Re-queue any tasks left active from a previous crash
  if (state.activeTasks.length > 0) {
    log(`Clearing ${state.activeTasks.length} stale active task(s) from previous run`)
    state.activeTasks = []
    saveState(state)
  }

  const shutdown = () => {
    log('Daemon shutting down')
    if (activeChild) {
      log('Terminating active child process')
      activeChild.kill('SIGTERM')
    }
    clearPid()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const poll = async () => {
    try {
      await pollAndWork(state)
    } catch (err) {
      log(`Poll error: ${err instanceof Error ? err.message : String(err)}`)
    }
    setTimeout(poll, pollIntervalMs)
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

  const missing = prerequisites.filter((p) => !commandExists(p.cmd))
  if (missing.length > 0) {
    console.log(`\nMissing tools: ${missing.map((p) => p.label).join(', ')}`)
    console.log(`Run "/thunderbot-daemon start" to auto-install them with Homebrew.`)
  }

  try {
    console.log(`\nRecent logs:`)
    const content = readFileSync(logFile, 'utf-8').trim()
    const lines = content.split('\n')
    console.log(lines.slice(-10).join('\n'))
  } catch {
    // No log file yet
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
    console.log('Usage: bun run scripts/thunderbot/daemon.ts [start|stop|status]')
    process.exit(1)
}
