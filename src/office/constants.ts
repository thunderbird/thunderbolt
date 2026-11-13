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
  /** Largest workbook Excelize opens. It holds about 1.2 KB per cell, outside the VM's memory. */
  maxWorkbookBytes: 2 * 1024 * 1024,
  /** Largest unzipped size of a workbook Excelize opens, so a small zip cannot unpack into gigabytes. */
  workbookUnzipBytes: 64 * 1024 * 1024,
  /** Excelize's own WebAssembly memory. A run stops once it passes this. */
  workbookMemoryBytes: 512 * 1024 * 1024,
}

export type SandboxLimits = typeof sandboxLimits

/** How many formula errors a result lists, so a broken workbook cannot flood the model's context. */
export const maxFormulaErrors = 50
