// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Shared child lifecycle owned by both faces. Spawns the launch argv exactly
// once, wires stdout/exit/error, and exposes the controls the faces need:
// write to stdin (with backpressure return), pause/resume stdout, graceful stop
// (signal then a grace window then SIGKILL), and an immediate SIGKILL. It NEVER
// restarts the child — on exit the supervisor reports once and stays dead.

import { spawn as defaultSpawn } from 'node:child_process'
import type { SuperviseChild } from './types'

/** Time the child gets to exit on its own after a stop signal before SIGKILL. */
const GRACE_MS = 2000

/**
 * Spawn and supervise a single child process, exposing the controls the ACP/MCP
 * faces need. The child is spawned exactly once and never respawned. stdio:
 * child stderr is inherited so its diagnostics pass straight through to the
 * bridge's stderr and never pollute the bridge's stdout (sacred framing).
 */
const superviseChild: SuperviseChild = ({
  launch,
  spawn = defaultSpawn,
  onStdout,
  onExit,
  onSpawnError,
  logger,
  graceMs = GRACE_MS,
}) => {
  const child = spawn(launch[0], launch.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })

  const state = { alive: true, exited: false }
  let graceTimer: NodeJS.Timeout | null = null

  const clearGrace = (): void => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }

  child.on('error', (err) => {
    if (state.exited) return
    state.exited = true
    state.alive = false
    clearGrace()
    onSpawnError(err)
  })

  child.stdout!.on('data', onStdout)

  child.on('exit', (code, signal) => {
    if (state.exited) return
    state.exited = true
    state.alive = false
    clearGrace()
    onExit({ code, signal })
  })

  return {
    child,

    writeStdin(chunk) {
      if (!state.alive || child.stdin!.destroyed || child.stdin!.writableEnded) return true
      return child.stdin!.write(chunk)
    },

    pauseStdout() {
      child.stdout!.pause()
    },

    resumeStdout() {
      child.stdout!.resume()
    },

    stop(signal = 'SIGTERM') {
      if (!state.alive) return
      child.kill(signal)
      clearGrace()
      graceTimer = setTimeout(() => {
        // Never-orphan: if the child ignored the signal, force it down.
        if (state.alive) {
          logger.error('child-grace-timeout', { code: 'SIGKILL' })
          child.kill('SIGKILL')
        }
      }, graceMs)
      // Don't keep the event loop alive solely for the grace timer.
      if (typeof graceTimer.unref === 'function') graceTimer.unref()
    },

    kill() {
      clearGrace()
      if (state.alive) child.kill('SIGKILL')
    },

    alive() {
      return state.alive
    },
  }
}

export { superviseChild }
