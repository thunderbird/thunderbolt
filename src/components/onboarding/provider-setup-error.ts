/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { classifyErrorKind } from '@/lib/error-utils'

type SetupStage = 'catalog' | 'model' | 'probe' | 'save'
/** Retain a failed setup stage without exposing provider responses or credentials. */
export class ProviderSetupError extends Error {
  constructor(
    readonly stage: SetupStage,
    cause?: unknown,
  ) {
    super(stage === 'model' ? 'Default model unavailable' : 'Provider setup failed', { cause })
  }
}

/** Attach context at each external boundary; callers own cancellation and the UI. */
export const runProviderSetupStage = async <T>(stage: SetupStage, operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (cause) {
    throw new ProviderSetupError(stage, cause)
  }
}

/** Only prewritten messages and numeric status codes may reach the UI. */
export const providerSetupErrorMessage = (error: unknown) => {
  const cause = error instanceof ProviderSetupError ? error.cause : error
  const kind = classifyErrorKind(cause)
  if (kind === 'attestation') {
    return msg`Could not verify Tinfoil's secure environment. Finish any macOS keychain prompts, then try again.`
  }
  if (kind === 'timeout' || (cause instanceof Error && cause.name === 'TimeoutError')) {
    return msg`The model connection test timed out. Please try again.`
  }
  if (typeof cause === 'object' && cause !== null) {
    const status =
      'statusCode' in cause
        ? cause.statusCode
        : 'response' in cause && cause.response instanceof Response
          ? cause.response.status
          : undefined
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) {
      return msg`The provider rejected the model request (HTTP ${status}). Check model access and your subscription.`
    }
  }
  if (error instanceof ProviderSetupError) {
    if (error.stage === 'catalog') {
      return msg`Could not load the provider's model list. Please try again.`
    }
    if (error.stage === 'model') {
      return msg`Thunderbolt's default model is not available from this provider.`
    }
    if (error.stage === 'save') {
      return msg`Could not save the provider connection on this device.`
    }
  }
  return msg`The model verification request failed. Please try again.`
}
