/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '../lib/install-webkit-own-property'

// A real file served by the app: the app CSP and the Tauri webviews block blob: and data: Workers.
import excelizeUrl from 'excelize-wasm/excelize.wasm.gz?url'
import { loadBytes } from './app-asset'
import { loadExcelize } from './excelize-engine'
import type { PreviewWorkerMessage } from './xlsx-preview-client'
import { answerRequest, createPreviewReader, type PreviewRequest } from './xlsx-preview-reader'

/** Excelize alone: the preview computes no formula, so IronCalc and the script sandbox never load here. */
const loadReader = async () => createPreviewReader(await loadExcelize(await loadBytes(excelizeUrl)))

const reader = loadReader()

/**
 * Tell the host that Excelize has loaded. The host times calls only from then, so a slow download is not taken for a
 * large workbook.
 */
const announce = async () => {
  try {
    await reader
  } catch (error) {
    console.error('[xlsx-preview] Could not load Excelize', error)
    self.postMessage('loadFailed' satisfies PreviewWorkerMessage)
    return
  }
  self.postMessage('ready' satisfies PreviewWorkerMessage)
}
void announce()

/**
 * One workbook per Worker, kept open while the preview is. The host terminates the Worker, which frees Excelize's
 * memory. If Excelize fails to load, no request is answered: the host gives up when it gets `loadFailed`.
 */
self.onmessage = async ({ data }: MessageEvent<PreviewRequest>) => {
  self.postMessage(answerRequest(await reader, data) satisfies PreviewWorkerMessage)
}
