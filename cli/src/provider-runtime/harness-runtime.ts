/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toError } from '@earendil-works/pi-agent-core'
import type { AgentHarness } from '@earendil-works/pi-agent-core'
import { modelsAreEqual } from '@earendil-works/pi-ai'
import type { MutableModels } from '@earendil-works/pi-ai'
import { cleanupFailure, collect, withCleanupErrors } from '../agent/cleanup-errors.ts'
import type { HarnessRuntime, PreparedPiBinding } from './types.ts'

type BindingCleanupState = {
  readonly binding: PreparedPiBinding
  unsubscribe: (() => void) | null
  disposed: boolean
}

export type PiHarnessRuntimeOptions = {
  readonly harness: AgentHarness
  readonly models: MutableModels
  readonly binding: PreparedPiBinding
  readonly cleanupHarness: () => Promise<void>
}

/** Assert ownership and install one prepared binding into a mutable Pi registry. */
export const installPreparedBinding = (models: MutableModels, binding: PreparedPiBinding): void => {
  if (binding.piModel.provider !== binding.providerId) {
    throw new Error(
      `Prepared binding owner "${binding.providerId}" does not match Pi provider "${binding.piModel.provider}".`,
    )
  }

  binding.install(models)
  if (!models.getModel(binding.piModel.provider, binding.piModel.id)) {
    throw new Error(`Prepared binding "${binding.providerId}" did not install Pi model "${binding.piModel.id}".`)
  }
}

/** Build cleanup bookkeeping for an attached or not-yet-attached binding. */
const createBindingCleanupState = (
  binding: PreparedPiBinding,
  unsubscribe: (() => void) | null = null,
): BindingCleanupState => ({
  binding,
  unsubscribe,
  disposed: false,
})

/** Run every outstanding cleanup action and return normalized failures. */
const cleanupBindingState = async (state: BindingCleanupState): Promise<Error[]> => {
  const errors: Error[] = []

  if (state.unsubscribe) {
    const unsubscribe = state.unsubscribe
    await collect(errors, () => {
      unsubscribe()
      state.unsubscribe = null
    })
  }

  if (!state.disposed) {
    await collect(errors, async () => {
      await state.binding.dispose()
      state.disposed = true
    })
  }

  return errors
}

/**
 * Wrap one Pi harness and mutable registry with binding and transaction ownership.
 * The initial binding must already be installed in `models`.
 */
export const createPiHarnessRuntime = async (options: PiHarnessRuntimeOptions): Promise<HarnessRuntime> => {
  const { harness, models } = options
  await harness.setSteeringMode('one-at-a-time')
  const initialUnsubscribe = options.binding.attach(harness)
  let activeBinding: BindingCleanupState | null = createBindingCleanupState(options.binding, initialUnsubscribe)
  const retiredBindings = new Set<BindingCleanupState>()
  const runtimeSubscriptions = new Set<() => void>()
  let promptActive = false
  let transitionActive = false
  let disposed = false
  let disposePromise: Promise<void> | null = null
  let promptDone: Promise<void> = Promise.resolve()
  let transitionDone: Promise<void> = Promise.resolve()

  /** Retire a binding now and retain failed work for the runtime disposal pass. */
  const retireBinding = async (state: BindingCleanupState): Promise<Error[]> => {
    retiredBindings.add(state)
    const errors = await cleanupBindingState(state)
    if (state.unsubscribe === null && state.disposed) retiredBindings.delete(state)
    return errors
  }

  /** Reject an operation after disposing the prepared binding whose ownership was transferred in. */
  const rejectOwnedBinding = async (binding: PreparedPiBinding, error: Error): Promise<never> => {
    const cleanupErrors = await retireBinding(createBindingCleanupState(binding))
    throw withCleanupErrors(error, cleanupErrors)
  }

  /** Enter the single transition lane and expose a completion promise to disposal. */
  const beginTransition = (): (() => void) => {
    const completion = Promise.withResolvers<void>()
    transitionActive = true
    transitionDone = completion.promise
    return () => {
      transitionActive = false
      completion.resolve()
    }
  }

  /** Restore the live model/provider and detach a failed candidate before durable rollback. */
  const restoreLiveBinding = async (
    previous: BindingCleanupState,
    candidate: BindingCleanupState,
    modelChangeAttempted: boolean,
  ): Promise<Error[]> => {
    const errors: Error[] = []

    await collect(errors, () => {
      installPreparedBinding(models, previous.binding)
    })

    if (modelChangeAttempted) {
      await collect(errors, async () => {
        await harness.setModel(previous.binding.piModel)
      })
    }

    if (candidate.binding.providerId !== previous.binding.providerId) {
      models.deleteProvider(candidate.binding.providerId)
    }

    if (candidate.unsubscribe) {
      const unsubscribe = candidate.unsubscribe
      await collect(errors, () => {
        unsubscribe()
        candidate.unsubscribe = null
      })
    }
    return errors
  }

  const subscribe: HarnessRuntime['subscribe'] = (listener) => {
    if (disposed) throw new Error('Harness runtime is disposed.')
    const unsubscribeHarness = harness.subscribe(listener)
    let subscribed = true
    const unsubscribe = () => {
      if (!subscribed) return
      subscribed = false
      runtimeSubscriptions.delete(unsubscribe)
      unsubscribeHarness()
    }
    runtimeSubscriptions.add(unsubscribe)
    return unsubscribe
  }

  const registerToolCallGate: HarnessRuntime['registerToolCallGate'] = (handler) => {
    if (disposed) throw new Error('Harness runtime is disposed.')
    const unsubscribe = harness.on('tool_call', handler)
    runtimeSubscriptions.add(unsubscribe)
  }

  const steer: HarnessRuntime['steer'] = (text) => harness.steer(text)

  const prompt: HarnessRuntime['prompt'] = async (text) => {
    if (disposed) throw new Error('Harness runtime is disposed.')
    if (!activeBinding) throw new Error('Harness runtime is deactivated.')
    if (promptActive) throw new Error('A harness prompt is active.')
    if (transitionActive) throw new Error('A harness binding transition is active.')

    const binding = activeBinding.binding
    const completion = Promise.withResolvers<void>()
    promptActive = true
    promptDone = completion.promise

    const runPrompt = async () => {
      try {
        const message = await harness.prompt(text)
        await harness.waitForIdle()
        return message
      } catch (error) {
        try {
          await binding.observePromptError(toError(error))
        } catch (observationError) {
          throw withCleanupErrors(toError(error), [toError(observationError)])
        }
        throw error
      }
    }

    try {
      const message = await runPrompt()
      if (message.stopReason === 'error') await binding.observePromptError(message)
      return message
    } finally {
      promptActive = false
      completion.resolve()
    }
  }

  const abort: HarnessRuntime['abort'] = async () => {
    if (disposed) throw new Error('Harness runtime is disposed.')
    await harness.abort()
  }

  const currentProviderId = (): string | null => activeBinding?.binding.providerId ?? null

  /** Detaches one live binding while retaining an irreversible cleanup failure. */
  const detachForDeactivation = (
    previous: BindingCleanupState,
    onPersistFailure: 'restore-binding' | 'remain-deactivated',
  ): Error | null => {
    try {
      previous.unsubscribe?.()
      previous.unsubscribe = null
      return null
    } catch (error) {
      const failure = toError(error)
      if (onPersistFailure === 'restore-binding') throw failure
      previous.unsubscribe = null
      return failure
    }
  }

  /** Restores a binding after reversible persistence fails. */
  const restoreAfterPersistFailure = async (previous: BindingCleanupState, failure: Error): Promise<never> => {
    try {
      installPreparedBinding(models, previous.binding)
      const unsubscribe = previous.binding.attach(harness)
      activeBinding = createBindingCleanupState(previous.binding, unsubscribe)
    } catch (restoreError) {
      models.deleteProvider(previous.binding.providerId)
      const cleanupErrors = await retireBinding(previous)
      throw withCleanupErrors(failure, [toError(restoreError), ...cleanupErrors])
    }
    throw failure
  }

  const switchBinding: HarnessRuntime['switchBinding'] = async (binding, transaction, switchOptions) => {
    if (disposed) return rejectOwnedBinding(binding, new Error('Harness runtime is disposed.'))
    if (promptActive) return rejectOwnedBinding(binding, new Error('A harness prompt is active.'))
    if (transitionActive) return rejectOwnedBinding(binding, new Error('A harness binding transition is active.'))
    if (!activeBinding) return rejectOwnedBinding(binding, new Error('Harness runtime is deactivated.'))

    const finishTransition = beginTransition()
    const previous = activeBinding
    const candidate = createBindingCleanupState(binding)
    let modelChangeAttempted = false

    try {
      await harness.waitForIdle()
      if (disposed) return rejectOwnedBinding(binding, new Error('Harness runtime is disposed.'))

      const modelChanged = !modelsAreEqual(previous.binding.piModel, binding.piModel)
      const shouldActivate =
        switchOptions.forceReplace || modelChanged || previous.binding.providerId !== binding.providerId

      if (!shouldActivate) {
        try {
          await transaction.commit()
          await transaction.finalize()
        } catch (error) {
          const cleanupErrors = await retireBinding(candidate)
          throw withCleanupErrors(toError(error), cleanupErrors)
        }

        const cleanupErrors = await retireBinding(candidate)
        if (cleanupErrors.length > 0) throw cleanupFailure('Prepared binding cleanup failed.', cleanupErrors)
        return
      }

      try {
        await transaction.commit()
      } catch (error) {
        const cleanupErrors = await retireBinding(candidate)
        throw withCleanupErrors(toError(error), cleanupErrors)
      }

      try {
        installPreparedBinding(models, binding)
        candidate.unsubscribe = binding.attach(harness)
        if (modelChanged) {
          modelChangeAttempted = true
          await harness.setModel(binding.piModel)
        }
      } catch (error) {
        const rollbackErrors = await restoreLiveBinding(previous, candidate, modelChangeAttempted)
        await collect(rollbackErrors, transaction.rollback)
        rollbackErrors.push(...(await retireBinding(candidate)))
        throw withCleanupErrors(toError(error), rollbackErrors)
      }

      activeBinding = candidate
      const postCommitErrors: Error[] = []
      await collect(postCommitErrors, transaction.finalize)
      if (previous.binding.providerId !== binding.providerId) models.deleteProvider(previous.binding.providerId)
      postCommitErrors.push(...(await retireBinding(previous)))
      if (postCommitErrors.length > 0) {
        throw cleanupFailure('Binding switch post-commit cleanup failed.', postCommitErrors)
      }
    } finally {
      finishTransition()
    }
  }

  const deactivate: HarnessRuntime['deactivate'] = async (persist, deactivateOptions) => {
    if (disposed) throw new Error('Harness runtime is disposed.')
    if (promptActive) throw new Error('A harness prompt is active.')
    if (transitionActive) throw new Error('A harness binding transition is active.')
    if (!activeBinding) throw new Error('Harness runtime is deactivated.')

    const finishTransition = beginTransition()
    const previous = activeBinding

    try {
      await harness.waitForIdle()
      if (disposed) throw new Error('Harness runtime is disposed.')

      const unsubscribeError = detachForDeactivation(previous, deactivateOptions.onPersistFailure)

      models.deleteProvider(previous.binding.providerId)
      activeBinding = null

      try {
        await persist()
      } catch (error) {
        if (deactivateOptions.onPersistFailure === 'restore-binding') {
          return restoreAfterPersistFailure(previous, toError(error))
        }

        const cleanupErrors = [
          ...(unsubscribeError === null ? [] : [unsubscribeError]),
          ...(await retireBinding(previous)),
        ]
        throw withCleanupErrors(toError(error), cleanupErrors)
      }

      const cleanupErrors = [
        ...(unsubscribeError === null ? [] : [unsubscribeError]),
        ...(await retireBinding(previous)),
      ]
      if (cleanupErrors.length > 0) throw cleanupFailure('Deactivated binding cleanup failed.', cleanupErrors)
    } finally {
      finishTransition()
    }
  }

  const dispose: HarnessRuntime['dispose'] = () => {
    if (disposePromise) return disposePromise
    disposed = true

    disposePromise = (async () => {
      const errors: Error[] = []

      if (promptActive) {
        await collect(errors, async () => {
          await harness.abort()
        })
        await promptDone
      }

      await transitionDone

      for (const unsubscribe of [...runtimeSubscriptions]) {
        await collect(errors, unsubscribe)
      }
      runtimeSubscriptions.clear()

      if (activeBinding) {
        models.deleteProvider(activeBinding.binding.providerId)
        const current = activeBinding
        activeBinding = null
        errors.push(...(await retireBinding(current)))
      }

      for (const retired of [...retiredBindings]) {
        errors.push(...(await retireBinding(retired)))
      }

      await collect(errors, options.cleanupHarness)

      if (errors.length > 0) throw cleanupFailure('Harness runtime disposal failed.', errors)
    })()

    return disposePromise
  }

  return { subscribe, registerToolCallGate, steer, prompt, abort, currentProviderId, switchBinding, deactivate, dispose }
}
