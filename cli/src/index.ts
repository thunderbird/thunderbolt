#!/usr/bin/env bun
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Binary entrypoint. Parses argv, dispatches the terminal info actions
 * (`help`/`version`/`error`) inline, and runs the agent inside the single
 * top-level try/catch that turns any uncaught failure into a clean exit.
 */

import { HELP_TEXT, VERSION, parseArgs } from './cli.ts'
import { runAgent } from './agent/run.ts'
import { runAcpServe } from './acp/serve.ts'
import { runBridge } from './commands/bridge.ts'
import { runIrohBridge } from './iroh/bridge.ts'
import { runIrohConnect } from './iroh/connect.ts'
import { runIrohAdmin } from './iroh/admin.ts'
import { runLogin } from './auth/login.ts'

const parsed = parseArgs(Bun.argv.slice(2))

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
  case 'run':
    try {
      await runAgent(parsed.config)
    } catch (err) {
      process.stderr.write(`thunderbolt: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
    break
  case 'bridge':
    try {
      if (parsed.config.transport === 'iroh') await runIrohBridge(parsed.config)
      else await runBridge(parsed.config)
    } catch (err) {
      process.stderr.write(`thunderbolt: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
    break
  case 'connect':
    try {
      await runIrohConnect(parsed.config)
    } catch (err) {
      process.stderr.write(`thunderbolt: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
    break
  case 'acp-serve':
    try {
      await runAcpServe(parsed.config)
    } catch (err) {
      process.stderr.write(`thunderbolt: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
    break
  case 'iroh-admin':
    try {
      await runIrohAdmin(parsed.action)
    } catch (err) {
      process.stderr.write(`thunderbolt: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
    break
  case 'login':
    try {
      await runLogin()
    } catch (err) {
      process.stderr.write(`thunderbolt: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    }
    break
}
