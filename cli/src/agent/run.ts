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
import { attachPermissionGate } from './permissions.ts'
import { createTerminalIO } from '../ui/prompt.ts'
import { printBanner } from '../banner.ts'
import type { RunConfig, TerminalIO } from './types.ts'

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
 * Runs the agent for a single CLI invocation. Requires `ANTHROPIC_API_KEY`;
 * exits with a friendly message when it's absent.
 *
 * @param config - the resolved configuration from `parseArgs`
 */
export const runAgent = async (config: RunConfig): Promise<void> => {
  // Anthropic resolves its key from the environment; openai-compat carries its
  // own (validated in `resolveModel`), so it must not demand ANTHROPIC_API_KEY.
  if ((config.provider ?? 'anthropic') === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('set ANTHROPIC_API_KEY to run the agent (https://console.anthropic.com).')
  }

  const { harness, dispose } = await buildHarness(config)
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
    await dispose()
  }
}
