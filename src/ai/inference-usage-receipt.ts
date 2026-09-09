/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import { inferenceUsageReceiptPath, type InferenceUsageReceiptRequest } from '@shared/inference-usage'

// Receipt storage is a same-backend write; bound automatic step delay without coupling it to chat cancellation.
const receiptPostTimeoutMs = 3_000

/** Submit shared confidential usage through the authenticated app client. */
export const submitInferenceUsageReceipt = async (
  usage: InferenceUsageReceiptRequest,
  httpClient: Pick<HttpClient, 'post'>,
): Promise<void> => {
  await httpClient.post(inferenceUsageReceiptPath, { json: usage, timeout: receiptPostTimeoutMs })
}
