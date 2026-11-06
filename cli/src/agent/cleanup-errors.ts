/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toError } from '@earendil-works/pi-agent-core'

type CleanupAction = () => void | Promise<void>

/** Adds one normalized cleanup failure to an existing collector. */
export const collect = async (errors: Error[], action: CleanupAction): Promise<void> => {
  try {
    await action()
  } catch (error) {
    errors.push(toError(error))
  }
}

/** Runs every cleanup action and returns normalized failures. */
export const collectCleanupErrors = async (actions: readonly CleanupAction[]): Promise<Error[]> => {
  const errors: Error[] = []
  for (const action of actions) {
    await collect(errors, action)
  }
  return errors
}

/** Returns one cleanup failure directly or combines several without losing causes. */
export const cleanupFailure = (message: string, errors: readonly Error[]): Error => {
  if (errors.length === 1 && errors[0]) return errors[0]
  return new AggregateError(errors, message)
}

/** Preserves a primary failure while appending cleanup failures. */
export const withCleanupErrors = (primary: Error, cleanupErrors: readonly Error[]): Error => {
  if (cleanupErrors.length === 0) return primary
  return new AggregateError([primary, ...cleanupErrors], primary.message)
}
