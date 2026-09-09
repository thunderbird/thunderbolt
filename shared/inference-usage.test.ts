/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { inferenceModelHeader, inferenceUsageReceiptHeader, inferenceUsageReceiptPath } from './inference-usage'

describe('managed inference usage contract', () => {
  it('owns the outer-hop model and receipt headers and receipt path', () => {
    expect(inferenceModelHeader).toBe('X-Inference-Model')
    expect(inferenceUsageReceiptHeader).toBe('X-Inference-Usage-Receipt')
    expect(inferenceUsageReceiptPath).toBe('inference-usage/receipts')
  })
})
