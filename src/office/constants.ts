/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Name of the agent tool that builds Office files. Shared by the tool and the transcript, so they can't drift. */
export const officeScriptToolName = 'run_office_script'

/**
 * Limits on one run. The VM interrupt enforces the time; the Worker host backs it up with a watchdog.
 * Kept apart from the sandbox so the host can read them without loading quickjs-wasi.
 */
export const sandboxLimits = {
  timeoutMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  textOutputBytes: 4 * 1024 * 1024,
  maxFiles: 20,
}

export type SandboxLimits = typeof sandboxLimits

/** Longest file name the tool cleans. Checked before `safeFileName`, whose trimming backtracks on a long run of dots. */
export const maxFilenameLength = 200
