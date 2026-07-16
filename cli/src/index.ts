#!/usr/bin/env bun
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Binary entrypoint. Loads persisted defaults, parses argv, dispatches commands,
 * and turns uncaught failures into clean terminal errors at one boundary.
 */

import { HELP_TEXT, VERSION, parseArgs } from './cli.ts'
import { runAgent } from './agent/run.ts'
import { runAcpServe } from './acp/serve.ts'
import { runBridge } from './commands/bridge.ts'
import { runIrohBridge } from './iroh/bridge.ts'
import { runIrohConnect } from './iroh/connect.ts'
import { runIrohAdmin } from './iroh/admin.ts'
import { loadConfig } from './config/config.ts'
import type { CliConfig } from './config/config.ts'
import { createSetupWizardIO, runSetupWizard, shouldRunSetupWizard } from './config/wizard.ts'
import type { ModelProvider } from './agent/types.ts'

/** Runs interactive setup with production terminal I/O and guaranteed cleanup. */
const configure = async (requiredProvider?: ModelProvider): Promise<CliConfig> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('config requires stdin and stdout to be terminals')
  }
  const io = createSetupWizardIO()
  try {
    return await runSetupWizard(io, { requiredProvider })
  } finally {
    io.close()
  }
}

try {
  const argv = Bun.argv.slice(2)
  const storedConfig = await loadConfig()
  const parsed = parseArgs(argv, { config: storedConfig })

  switch (parsed.kind) {
    case 'help':
      console.log(HELP_TEXT)
      break
    case 'version':
      console.log(VERSION)
      break
    case 'error':
      process.stderr.write(parsed.message + '\n')
      process.exitCode = 1
      break
    case 'config':
      await configure()
      break
    case 'run': {
      if (
        shouldRunSetupWizard(parsed.config, {
          stdinIsTty: Boolean(process.stdin.isTTY),
          stdoutIsTty: Boolean(process.stdout.isTTY),
          env: process.env,
        })
      ) {
        const requiredProvider = argv.includes('--provider') ? parsed.config.provider : undefined
        const freshConfig = await configure(requiredProvider)
        const reparsed = parseArgs(argv, { config: freshConfig })
        if (reparsed.kind !== 'run') throw new Error('failed to resume agent after setup')
        await runAgent(reparsed.config)
        break
      }
      await runAgent(parsed.config)
      break
    }
    case 'bridge':
      if (parsed.config.transport === 'iroh') await runIrohBridge(parsed.config)
      else await runBridge(parsed.config)
      break
    case 'connect':
      await runIrohConnect(parsed.config)
      break
    case 'acp-serve':
      await runAcpServe(parsed.config)
      break
    case 'iroh-admin':
      await runIrohAdmin(parsed.action)
      break
  }
} catch (error) {
  process.stderr.write(`thunderbolt: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
