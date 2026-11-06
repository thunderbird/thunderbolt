/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Configures the process-global ZenFS singleton that backs
 * {@link BrowserExecutionEnv}. ZenFS is a singleton (like `node:fs`), so it must
 * be mounted exactly once before constructing an env.
 *
 * Two mounts are provided:
 *   - {@link mountInMemoryFs} — an ephemeral in-memory mount for Node/tests and
 *     non-OPFS contexts.
 *   - {@link mountAgentFs} — the app entry point: prefers an OPFS-backed
 *     `@zenfs/dom` `WebAccess` mount (persists across reloads) and falls back to
 *     in-memory when OPFS is unavailable. It is memoised so repeated harness
 *     builds share the single global mount instead of reconfiguring it.
 */

import { configureSingle, InMemory } from '@zenfs/core'
import { WebAccess } from '@zenfs/dom'

/** Backend that ended up mounted, for the caller's diagnostics. */
export type MountedBackend = 'opfs' | 'memory'

/**
 * Mount an in-memory ZenFS at `/`. Used by tests, by Node spikes, and as the
 * fallback when the browser exposes no OPFS. Both Pi's filesystem API and
 * just-bash share whatever backend is mounted here.
 */
export const mountInMemoryFs = async (): Promise<void> => {
  await configureSingle({ backend: InMemory })
}

/** Whether the current context exposes the Origin Private File System. */
const isOpfsAvailable = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'

/** Performs the actual mount: OPFS when available and usable, in-memory otherwise.
 *  Always resolves (never rejects) so the memoised mount can't get stuck on a
 *  rejected promise — an unusable OPFS degrades to the in-memory backend. */
const doMountAgentFs = async (): Promise<MountedBackend> => {
  if (isOpfsAvailable()) {
    try {
      // The one-line OPFS swap: wire @zenfs/dom's WebAccess backend over the
      // origin's private directory handle. {@link BrowserExecutionEnv} and
      // {@link ZenBashFileSystem} both target whatever is mounted here.
      const handle = await navigator.storage.getDirectory()
      await configureSingle({ backend: WebAccess, handle })
      return 'opfs'
    } catch {
      // OPFS is exposed but unusable here (quota, private browsing, permission).
      // Fall through to the same in-memory mount used when OPFS is absent.
    }
  }
  await mountInMemoryFs()
  return 'memory'
}

/**
 * Module-scoped mount promise. ZenFS is a process-global singleton, so the mount
 * is a process-global one-time effect; memoising the promise makes repeated
 * `mountAgentFs()` calls (one per harness build) idempotent rather than
 * reconfiguring the live singleton underneath an in-flight env.
 */
let agentFsMount: Promise<MountedBackend> | undefined

/**
 * Mount the ZenFS singleton the app harness runs over, exactly once per process.
 * Prefers OPFS persistence and falls back to in-memory. Safe to call repeatedly —
 * subsequent calls return the same in-flight/settled mount.
 *
 * @returns the backend that was actually mounted (`opfs` or `memory`)
 */
export const mountAgentFs = (): Promise<MountedBackend> => {
  agentFsMount ??= doMountAgentFs()
  return agentFsMount
}

/**
 * Test-only: clear the memoised mount so the next `mountAgentFs()` re-evaluates
 * from scratch. Production never resets — the mount is a one-time per-process
 * effect — but the memo is process-global, so a test runner reusing the module
 * across reruns (e.g. `bun test --rerun-each`) would otherwise observe a stale
 * settled promise instead of a fresh OPFS attempt. Not re-exported from the
 * package entry point; tests import it directly from this module.
 */
export const resetAgentFsMountForTests = (): void => {
  agentFsMount = undefined
}
