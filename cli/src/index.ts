#!/usr/bin/env bun
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Binary entrypoint: parse syntax, create a provider runtime only when needed, and dispatch commands. */

import { runAcpServe } from './acp/serve.ts'
import { toError } from '@earendil-works/pi-agent-core'
import { runAgent } from './agent/run.ts'
import type { CommandSyntaxRunConfig, CommandSyntaxServeConfig } from './agent/types.ts'
import { createAccountActions, ensureRegisteredSession } from './auth/account-client.ts'
import { resolveCloudUrl, resolvePatToken } from './auth/config.ts'
import {
  compareAndSetAuthConfig,
  loadAuthConfig,
  resolveAccountCredential,
  toAuth,
} from './auth/token-store.ts'
import { cliVersion, helpText, parseCommandSyntax } from './cli.ts'
import { runBridge } from './commands/bridge.ts'
import { loadConfig, saveConfig } from './config/config.ts'
import { runIrohAdmin } from './iroh/admin.ts'
import { runIrohBridge } from './iroh/bridge.ts'
import { runIrohConnect } from './iroh/connect.ts'
import { createByokBinding } from './provider-runtime/byok.ts'
import { fetchManagedCatalog } from './provider-runtime/catalog.ts'
import { createManagedDirectBinding } from './provider-runtime/direct.ts'
import { runProviderManager } from './provider-runtime/manager.ts'
import { createProviderRuntime } from './provider-runtime/runtime.ts'
import { createTinfoilBinding } from './provider-runtime/tinfoil.ts'
import {
  defaultProviderStageContext,
  prepareProviderBinding,
} from './provider-runtime/provider-stage.ts'
import type {
  CommandOutcome,
  ProviderManagerMode,
  ProviderRuntime,
  SessionCredential,
} from './provider-runtime/types.ts'
import { createPlainProviderManagerIO } from './ui/provider-manager.ts'
import { createTerminalIO } from './ui/prompt.ts'

/** Persists the durable authentication-required state after a rejected stored session. */
const markSessionAuthenticationRequired = async (
  credential?: SessionCredential,
): Promise<void> => {
  const auth =
    credential === undefined
      ? await loadAuthConfig()
      : toAuth(credential, 'registered')
  if (auth === null || auth.registration === 'authentication-required') return
  await compareAndSetAuthConfig(
    { kind: 'exact', auth },
    { ...auth, registration: 'authentication-required', bearer: null },
  )
}

/** Creates the single production provider runtime from canonical v2 config, auth, catalog, and binding factories. */
const createProductionProviderRuntime = async (): Promise<ProviderRuntime> => {
  const environment = process.env
  const backendUrl = resolveCloudUrl(environment)
  const metadata = { deviceName: 'Thunderbolt CLI' }
  return createProviderRuntime({
    loadConfig,
    loadAuthConfig,
    saveConfig,
    resolveAccountCredential,
    accountActions: createAccountActions({
      backendUrl,
      metadata,
      patToken: resolvePatToken(environment),
    }),
    loadCatalog: fetchManagedCatalog,
    ensureRegisteredSession,
    markSessionAuthenticationRequired,
    metadata,
    createByokBinding,
    createManagedDirectBinding,
    createTinfoilBinding,
    environment,
    providerStage: defaultProviderStageContext,
  })
}

export type RunCliDependencies = {
  readonly parseCommandSyntax: typeof parseCommandSyntax
  readonly createProviderRuntime: () => Promise<ProviderRuntime>
  readonly runAgent: (config: CommandSyntaxRunConfig, runtime: ProviderRuntime) => Promise<void>
  readonly runAcpServe: (config: CommandSyntaxServeConfig, runtime: ProviderRuntime) => Promise<void>
  readonly runBridge: typeof runBridge
  readonly runIrohBridge: typeof runIrohBridge
  readonly runIrohConnect: typeof runIrohConnect
  readonly runIrohAdmin: typeof runIrohAdmin
  readonly createTerminalIO: typeof createTerminalIO
  readonly createPlainProviderManagerIO: typeof createPlainProviderManagerIO
  readonly runProviderManager: typeof runProviderManager
  readonly log: (text: string) => void
  readonly writeError: (text: string) => void
  readonly setExitCode: (code: number) => void
}

const defaultDependencies: RunCliDependencies = {
  parseCommandSyntax,
  createProviderRuntime: createProductionProviderRuntime,
  runAgent,
  runAcpServe,
  runBridge,
  runIrohBridge,
  runIrohConnect,
  runIrohAdmin,
  createTerminalIO,
  createPlainProviderManagerIO,
  runProviderManager,
  log: console.log,
  writeError: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code
  },
}

/** Applies a manager-owned deferred persistence command when no harness transaction exists. */
const applyStandaloneOutcome = async (
  outcome: CommandOutcome,
  runtime: ProviderRuntime,
  signal?: AbortSignal,
): Promise<void> => {
  if (outcome.kind === 'deactivate') {
    try {
      if (outcome.persist !== null) await runtime.manage(outcome.persist)
    } catch (error) {
      if (outcome.failure !== undefined) {
        throw new AggregateError([outcome.failure, error], outcome.failure.message)
      }
      throw error
    }
    if (outcome.failure !== undefined) throw outcome.failure
    return
  }
  if (outcome.kind !== 'switch') return

  const binding = await prepareProviderBinding(runtime, outcome.selection, { signal })
  try {
    await runtime.manage(outcome.persist)
  } finally {
    await binding.dispose()
  }
}

/** Runs one standalone profile action with the shared plain provider-manager presentation. */
const runStandaloneProviderManager = async (
  mode: ProviderManagerMode,
  runtime: ProviderRuntime,
  dependencies: RunCliDependencies,
): Promise<void> => {
  const terminal = dependencies.createTerminalIO()
  try {
    const outcome = await dependencies.runProviderManager(
      dependencies.createPlainProviderManagerIO(terminal),
      runtime,
      mode,
      terminal.signal,
    )
    await applyStandaloneOutcome(outcome, runtime, terminal.signal)
  } finally {
    terminal.close()
  }
}

/** Parses and dispatches one CLI invocation, retaining the binary's single terminal error boundary. */
export const runCli = async (
  argv: readonly string[],
  dependencies: RunCliDependencies = defaultDependencies,
): Promise<void> => {
  try {
    const parsed = dependencies.parseCommandSyntax([...argv])
    switch (parsed.kind) {
      case 'help':
        dependencies.log(helpText)
        return
      case 'version':
        dependencies.log(cliVersion)
        return
      case 'error':
        dependencies.writeError(`${parsed.message}\n`)
        dependencies.setExitCode(1)
        return
      case 'run': {
        const runtime = await dependencies.createProviderRuntime()
        await dependencies.runAgent(parsed.config, runtime)
        return
      }
      case 'acp-serve': {
        const runtime = await dependencies.createProviderRuntime()
        await dependencies.runAcpServe(parsed.config, runtime)
        return
      }
      case 'config':
      case 'login':
      case 'logout': {
        const runtime = await dependencies.createProviderRuntime()
        await runStandaloneProviderManager(parsed.kind === 'config' ? 'providers' : parsed.kind, runtime, dependencies)
        return
      }
      case 'bridge':
        if (parsed.config.transport === 'iroh') await dependencies.runIrohBridge(parsed.config)
        else await dependencies.runBridge(parsed.config)
        return
      case 'connect':
        await dependencies.runIrohConnect(parsed.config)
        return
      case 'iroh-admin':
        await dependencies.runIrohAdmin(parsed.action)
        return
      default: {
        const unsupported: never = parsed
        throw new Error(`Unsupported command syntax: ${JSON.stringify(unsupported)}`)
      }
    }
  } catch (error) {
    dependencies.writeError(`thunderbolt: ${toError(error).message}\n`)
    dependencies.setExitCode(1)
  }
}

if (import.meta.main) await runCli(Bun.argv.slice(2))
