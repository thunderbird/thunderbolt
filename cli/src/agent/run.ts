/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The agent run-loop: wires the harness, renderer, terminal I/O, and
 * permission gate together, then drives either a single prompt (oneshot) or
 * an interactive REPL. Harness teardown is guaranteed via `finally`.
 */

import type { AgentHarness } from '@earendil-works/pi-agent-core'
import { buildHarness } from './harness.ts'
import { attachRenderer } from '../ui/render.ts'
import { runTuiRepl } from '../ui/tui.ts'
import { attachPermissionGate } from './permissions.ts'
import { createTerminalIO } from '../ui/prompt.ts'
import { printBanner } from '../banner.ts'
import type { RunConfig, TerminalIO } from './types.ts'

/**
 * Decides whether the interactive REPL should use the rich TUI. The TUI is the
 * default, but it needs a real terminal to own — a piped/redirected stdout, the
 * `--no-tui` flag, or `THUNDERBOLT_NO_TUI` all fall back to the plain readline
 * loop. oneshot runs never use the TUI. Pure so mode selection is unit-testable.
 *
 * @param config - the resolved run configuration
 * @param env.isTty - whether stdout is a terminal
 * @param env.noTuiEnv - whether `THUNDERBOLT_NO_TUI` is set
 * @returns true when the TUI REPL should run
 */
export const shouldUseTui = (config: RunConfig, env: { isTty: boolean; noTuiEnv: boolean }): boolean =>
  config.mode === 'repl' && !config.noTui && env.isTty && !env.noTuiEnv

/**
 * Interactive read-eval loop: prompt the user, run each line through the
 * harness, and wait for the agent to go idle before reading the next one.
 * `exit`/`quit` ends the loop; blank lines are skipped.
 */
const runRepl = async (harness: AgentHarness, io: TerminalIO): Promise<void> => {
  while (true) {
    const line = await io.readLine('› ')
    // `null` is EOF (Ctrl-D / closed pipe); `exit`/`quit` are explicit quits.
    if (line === null || line === 'exit' || line === 'quit') return
    if (line === '') continue
    await harness.prompt(line)
    await harness.waitForIdle()
  }
}

/**
 * Runs agent for one CLI invocation. Harness model resolution validates
 * provider-specific credentials before execution resources are allocated.
 *
 * @param config - the resolved configuration from `parseArgs`
 */
export const runAgent = async (config: RunConfig): Promise<void> => {
  const { harness, dispose } = await buildHarness(config)

  try {
    if (
      shouldUseTui(config, { isTty: Boolean(process.stdout.isTTY), noTuiEnv: Boolean(process.env.THUNDERBOLT_NO_TUI) })
    ) {
      // The TUI owns stdin/stdout and its own renderer and permission gate.
      await runTuiRepl(harness, { yolo: config.yolo })
      return
    }

    // Plain path: oneshot runs and the non-TTY / --no-tui REPL fallback. Both
    // stream to stdout and read permission answers over a shared readline.
    attachRenderer(harness)
    const io = createTerminalIO()
    attachPermissionGate(harness, { yolo: config.yolo, ask: io.ask })
    try {
      if (config.mode === 'oneshot') {
        const result = await harness.prompt(config.prompt)
        await harness.waitForIdle()
        // A failed turn (bad key, rate limit) resolves rather than throwing, and
        // the renderer prints the error — propagate it to the exit code too.
        if (result.stopReason === 'error') process.exitCode = 1
        process.stdout.write('\n')
      } else {
        printBanner()
        await runRepl(harness, io)
      }
    } finally {
      io.close()
    }
  } finally {
    await dispose()
  }
}
