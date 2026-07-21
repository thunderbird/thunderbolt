/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BridgeProc } from '../commands/bridge.ts'

/** Kill a bridged subprocess whenever its connection settles, including when
 * `closed()` rejects because transport teardown itself failed. */
export const killProcessWhenConnectionCloses = (
  connection: { closed: () => Promise<unknown> },
  proc: Pick<BridgeProc, 'kill'>,
): void => {
  const kill = (): void => proc.kill()
  void connection.closed().then(kill).catch(kill)
}
