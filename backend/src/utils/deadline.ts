/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Run `work` with a signal that aborts `ms` from now, with the `TimeoutError` `AbortSignal.timeout` gives, and stop
 * the timer once `work` settles.
 *
 * Not `AbortSignal.timeout` itself: on Bun 1.3, removing that signal's last abort listener stops its timer for good,
 * so a deadline handed to code that adds and removes listeners as it goes, as the MCP client does between requests,
 * never fires.
 */
export const withDeadline = async <T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
