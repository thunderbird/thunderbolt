/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import type { PageAction } from '@shared/page-protocol'

/** Revoke native input even when Stop arrives before the queued UI callback starts. */
export const invokeBrowserAction = async (
  label: string,
  action: PageAction,
  signal?: AbortSignal,
  native: typeof invoke = invoke,
): Promise<void> => {
  signal?.throwIfAborted()
  const operationId = await native<number>('browser_begin_agent_action', { label })
  let cancellation: Promise<{ error: unknown } | undefined> | undefined
  const cancel = () => {
    // Observe rejection immediately: an abort listener cannot return an awaited promise.
    cancellation ??= native<void>('browser_cancel_agent_action', { label, operationId }).then(
      () => undefined,
      (error: unknown) => ({ error }),
    )
  }
  signal?.addEventListener('abort', cancel, { once: true })
  const failures: unknown[] = []
  try {
    signal?.throwIfAborted()
    await native('browser_agent_action', { label, operationId, action })
    signal?.throwIfAborted()
  } catch (error) {
    failures.push(error)
  } finally {
    signal?.removeEventListener('abort', cancel)
    cancel()
  }
  const cancellationFailure = await cancellation
  if (cancellationFailure) {
    failures.push(cancellationFailure.error)
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Browser input failed and its native operation could not be released.')
  }
}
