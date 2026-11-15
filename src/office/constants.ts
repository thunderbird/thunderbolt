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

/**
 * The most the spreadsheet preview reads and shows. The row and column caps were measured in Chromium, Firefox and
 * WebKit, but not with the Excelize reader. Lower them if measuring the reader in a browser calls for it.
 */
export const xlsxPreviewLimits = {
  /** A larger file is refused before a Worker starts or Excelize downloads. */
  fileBytes: sandboxLimits.maxWorkbookBytes,
  /** The same ceiling as the script tool's, so a small zip cannot unpack into gigabytes. */
  unzipBytes: sandboxLimits.workbookUnzipBytes,
  rows: 5_000,
  columns: 50,
  /** WebKit drew nothing for a cell of 32,767 characters; Excel itself shows about 1,000. */
  cellChars: 1_000,
  /**
   * The most a workbook's parts may unzip to, pictures aside, since Excelize may parse any of them. The largest
   * ordinary workbook measured under the file cap unzips to 11.7 MB.
   */
  partBytes: 32 * 1024 * 1024,
  /** A drawing or chart part past this is not read: xmldom takes about 60 bytes of memory per byte it parses. */
  xmlPartBytes: 2 * 1024 * 1024,
  /** A sheet with more merged ranges than this is not read: 25,000 kept the Worker busy for minutes. */
  merges: 10_000,
  /** The most values the charts of one sheet draw together. */
  chartPoints: 20_000,
  /**
   * The most rows and columns the grid freezes. A larger frozen pane scrolls instead: with rows a tenth of a pixel
   * tall, any number of them would fit.
   */
  frozenRows: 50,
  frozenColumns: 10,
}

/** How many formula errors a result lists, so a broken workbook cannot flood the model's context. */
export const maxFormulaErrors = 50
