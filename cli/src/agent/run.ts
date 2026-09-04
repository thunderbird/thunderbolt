/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Provider-aware bootstrap and direct CLI run loops. */

import { toError } from '@earendil-works/pi-agent-core'
import { printBanner } from '../banner.ts'
import { createCommandRouter, mustApplyAfterCancellation } from '../provider-runtime/commands.ts'
import { runProviderManager } from '../provider-runtime/manager.ts'
import {
  prepareProviderBinding,
  type ProviderPreparationOptions,
} from '../provider-runtime/provider-stage.ts'
import type {
  CommandOutcome,
  HarnessBindingTransaction,
  HarnessRuntime,
  InvocationSelection,
  PreparedPiBinding,
  ProviderManagerIO,
  ProviderRuntime,
} from '../provider-runtime/types.ts'
import { attachRenderer, sanitizeTerminalText } from '../ui/render.ts'
import { createPlainProviderManagerIO } from '../ui/provider-manager.ts'
import { createTerminalIO } from '../ui/prompt.ts'
import type { TerminalIO } from '../ui/prompt.ts'
import { runTuiRepl } from '../ui/tui.ts'
import { createHarnessRuntime } from './harness.ts'
import { attachPermissionGate, choosePermissionMode, type PermissionMode } from './permissions.ts'
import type { CommandSyntaxRunConfig } from './types.ts'

type TerminalEnvironment = {
  readonly interactive: boolean
  readonly stdoutIsTty: boolean
  readonly noTuiEnv: boolean
}
type PermissionModeState = { mode: PermissionMode }
type HarnessBootstrapContext = {
  readonly interactive: boolean
  readonly signal?: AbortSignal
}

export type RunAgentDependencies = {
  readonly createTerminalIO: () => TerminalIO
  readonly createHarnessRuntime: typeof createHarnessRuntime
  readonly runTuiRepl: typeof runTuiRepl
  readonly runProviderManager: typeof runProviderManager
  readonly attachRenderer: typeof attachRenderer
  readonly attachPermissionGate: typeof attachPermissionGate
  readonly printBanner: typeof printBanner
  readonly setExitCode: (code: number) => void
  readonly terminalEnvironment: () => TerminalEnvironment
}

/** Decides whether an interactive REPL should use the rich TUI. */
export const shouldUseTui = (config: CommandSyntaxRunConfig, env: { isTty: boolean; noTuiEnv: boolean }): boolean =>
  config.mode === 'repl' && !config.noTui && env.isTty && !env.noTuiEnv

/** Persists a first-run switch after preparing it, disposing on persistence failure. */
const commitBootstrapSwitch = async (
  config: CommandSyntaxRunConfig,
  outcome: Extract<CommandOutcome, { kind: 'switch' }>,
  runtime: ProviderRuntime,
  context: HarnessBootstrapContext,
): Promise<{ readonly config: CommandSyntaxRunConfig; readonly binding: PreparedPiBinding }> => {
  const prepared = await prepareProviderBinding(runtime, outcome.selection, { signal: context.signal })
  try {
    await runtime.manage(outcome.persist)
  } catch (error) {
    await prepared.dispose()
    throw error
  }
  return { config: { ...config, selection: outcome.selection }, binding: prepared }
}

/**
 * Resolves the initial binding before a harness exists. An active migrated
 * profile is prepared directly so its repair guidance surfaces without
 * reopening onboarding.
 */
export const bootstrapBeforeHarness = async (
  config: CommandSyntaxRunConfig,
  runtime: ProviderRuntime,
  io: ProviderManagerIO,
  terminal: HarnessBootstrapContext,
  manager: typeof runProviderManager = runProviderManager,
): Promise<{ readonly config: CommandSyntaxRunConfig; readonly binding: PreparedPiBinding }> => {
  const hasExplicitProvider = config.selection.providerId !== undefined
  const needsFirstRun = runtime.snapshot().activeProviderId === null && !hasExplicitProvider
  if (!needsFirstRun) {
    return { config, binding: await prepareProviderBinding(runtime, config.selection, { signal: terminal.signal }) }
  }

  if (!terminal.interactive) {
    throw new Error('Run thunderbolt in a terminal to choose a provider before starting inference.')
  }

  const outcome = await manager(io, runtime, 'first-run', terminal.signal)
  if (outcome.kind === 'switch') return commitBootstrapSwitch(config, outcome, runtime, terminal)
  throw new Error('Provider setup was cancelled before a provider was selected.')
}

/** Applies one routed command while keeping HarnessRuntime the live transaction owner. */
export const applyCommandOutcome = async (
  outcome: CommandOutcome,
  runtime: ProviderRuntime,
  harness: HarnessRuntime,
  preparation: ProviderPreparationOptions = {},
): Promise<InvocationSelection | null> => {
  if (outcome.kind === 'switch') {
    const prepared = await prepareProviderBinding(runtime, outcome.selection, preparation)
    let persistenceRevision: number | null = null
    const transaction: HarnessBindingTransaction = {
      commit: async () => {
        const committed = await runtime.manage({ type: 'commit-persistence', command: outcome.persist })
        persistenceRevision = committed.revision
      },
      rollback: async () => {
        if (persistenceRevision === null) throw new Error('Provider persistence was not committed.')
        await runtime.manage({ type: 'rollback-persistence', revision: persistenceRevision })
      },
      finalize: async () => {
        if (persistenceRevision === null) throw new Error('Provider persistence was not committed.')
        await runtime.manage({ type: 'finalize-persistence', revision: persistenceRevision })
      },
    }
    await harness.switchBinding(prepared, transaction, { forceReplace: outcome.forceReplace })
    return outcome.selection
  }

  if (outcome.kind === 'deactivate') {
    const onPersistFailure = outcome.persist?.type === 'remove-byok' ? 'restore-binding' : 'remain-deactivated'
    try {
      await harness.deactivate(
        async () => {
          if (outcome.persist !== null) await runtime.manage(outcome.persist)
        },
        { onPersistFailure },
      )
    } catch (error) {
      if (outcome.failure !== undefined) {
        throw new AggregateError([outcome.failure, error], outcome.failure.message)
      }
      throw error
    }
    if (outcome.failure !== undefined) throw outcome.failure
    return null
  }

  if (outcome.kind === 'forward') await harness.prompt(outcome.text)
  return null
}

/** Formats an interactive error without retaining a failed prompt for replay. */
const interactiveError = (error: Error): string => `Error: ${sanitizeTerminalText(error.message)}\n`

/** Aborts a harness once with its caller signal and exposes cleanup settlement. */
const abortOnSignal = (harness: HarnessRuntime, signal: AbortSignal) => {
  let abort: Promise<void> | undefined
  const abortHarness = (): void => {
    abort ??= harness.abort()
  }
  signal.addEventListener('abort', abortHarness, { once: true })
  if (signal.aborted) abortHarness()
  return {
    settle: async () => {
      signal.removeEventListener('abort', abortHarness)
      await abort
    },
  }
}

/** Runs one prompt with a cancellation listener scoped to that one-shot turn. */
const promptOneShot = async (
  harness: HarnessRuntime,
  prompt: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<HarnessRuntime['prompt']>> | null> => {
  const cancellation = abortOnSignal(harness, signal)

  try {
    if (signal.aborted) return null
    const result = await harness.prompt(prompt)
    if (!signal.aborted) return result
    return null
  } finally {
    await cancellation.settle()
  }
}

/** Drives the plain readline command router until EOF or an explicit exit. */
const runPlainRepl = async (
  harness: HarnessRuntime,
  runtime: ProviderRuntime,
  terminal: TerminalIO,
  managerIO: ProviderManagerIO,
  permissionState: PermissionModeState,
  manager: typeof runProviderManager,
): Promise<void> => {
  const { signal } = terminal
  const router = createCommandRouter(
    (mode) => manager(managerIO, runtime, mode, signal, harness.currentProviderId),
    async () => {
      permissionState.mode = await choosePermissionMode(managerIO, permissionState.mode)
      return { kind: 'handled' }
    },
  )
  const cancellation = abortOnSignal(harness, signal)
  try {
    while (true) {
      const line = await terminal.readLine('› ')
      if (line === null) return
      if (line.trim() === '') continue

      try {
        const outcome = await router.handle(line)
        if (signal.aborted && !mustApplyAfterCancellation(outcome)) return
        if (outcome.kind === 'exit') return
        await applyCommandOutcome(outcome, runtime, harness, { signal })
      } catch (error) {
        if (signal.aborted) return
        terminal.write(interactiveError(toError(error)))
      }
    }
  } finally {
    await cancellation.settle()
  }
}

/** Runs the TUI session and disposes any harness created during connection. */
const runTuiSession = async (
  config: CommandSyntaxRunConfig,
  runtime: ProviderRuntime,
  dependencies: RunAgentDependencies,
): Promise<void> => {
  let harness: HarnessRuntime | null = null
  const createdHarness = (): HarnessRuntime | null => harness
  try {
    await dependencies.runTuiRepl(runtime, {
      connect: async (io, signal) => {
        const bootstrapped = await bootstrapBeforeHarness(
          config,
          runtime,
          io,
          { interactive: true, signal },
          dependencies.runProviderManager,
        )
        const connectedHarness = await dependencies.createHarnessRuntime(bootstrapped.config, bootstrapped.binding)
        harness = connectedHarness
        return { harness: connectedHarness, model: bootstrapped.binding.wireModel }
      },
      initialPermissionMode: config.yolo ? 'yolo' : 'ask',
      fullscreen: config.fullscreen,
      thinking: config.thinking,
      applyOutcome: (outcome, connectedHarness, signal) =>
        applyCommandOutcome(outcome, runtime, connectedHarness, { signal }),
    })
  } finally {
    await createdHarness()?.dispose()
  }
}

/** Runs the plain session with one terminal owned and closed by this path. */
const runPlainSession = async (
  config: CommandSyntaxRunConfig,
  runtime: ProviderRuntime,
  dependencies: RunAgentDependencies,
  environment: TerminalEnvironment,
): Promise<void> => {
  const terminal = dependencies.createTerminalIO()
  let harness: HarnessRuntime | null = null
  try {
    const managerIO = createPlainProviderManagerIO(terminal)
    const bootstrapped = await bootstrapBeforeHarness(
      config,
      runtime,
      managerIO,
      { interactive: environment.interactive, signal: terminal.signal },
      dependencies.runProviderManager,
    )

    harness = await dependencies.createHarnessRuntime(bootstrapped.config, bootstrapped.binding)
    const permissionState: PermissionModeState = {
      mode: bootstrapped.config.yolo ? 'yolo' : 'ask',
    }

    dependencies.attachRenderer(harness)
    dependencies.attachPermissionGate(harness, { getMode: () => permissionState.mode, ask: terminal.ask })
    if (bootstrapped.config.mode === 'oneshot') {
      const result = await promptOneShot(harness, bootstrapped.config.prompt, terminal.signal)
      if (result === null) {
        dependencies.setExitCode(130)
        return
      }
      if (result.stopReason === 'error') dependencies.setExitCode(1)
      terminal.write('\n')
      return
    }

    dependencies.printBanner()
    await runPlainRepl(harness, runtime, terminal, managerIO, permissionState, dependencies.runProviderManager)
  } finally {
    try {
      if (harness) await harness.dispose()
    } finally {
      terminal.close()
    }
  }
}

/** Builds a run function around injectable terminal/harness seams for ordering tests. */
export const createRunAgent =
  (dependencies: RunAgentDependencies) =>
  async (config: CommandSyntaxRunConfig, runtime: ProviderRuntime): Promise<void> => {
    const environment = dependencies.terminalEnvironment()
    const useTui = environment.interactive && shouldUseTui(config, {
      isTty: environment.stdoutIsTty,
      noTuiEnv: environment.noTuiEnv,
    })
    return useTui
      ? runTuiSession(config, runtime, dependencies)
      : runPlainSession(config, runtime, dependencies, environment)
  }

const defaultDependencies: RunAgentDependencies = {
  createTerminalIO,
  createHarnessRuntime,
  runTuiRepl,
  runProviderManager,
  attachRenderer,
  attachPermissionGate,
  printBanner,
  setExitCode: (code) => {
    process.exitCode = code
  },
  terminalEnvironment: () => ({
    interactive: Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
    stdoutIsTty: Boolean(process.stdout.isTTY),
    noTuiEnv: Boolean(process.env.THUNDERBOLT_NO_TUI),
  }),
}

/** Runs one direct CLI invocation against the injected provider runtime. */
export const runAgent = createRunAgent(defaultDependencies)
