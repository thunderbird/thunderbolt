/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { defaultModelGlm52 } from './defaults/models'
import { inferenceUsageReceiptPath, managedGlmIdentity } from './inference-usage'

describe('managed inference usage contract', () => {
  it('owns the canonical managed GLM identity and receipt path', () => {
    expect(managedGlmIdentity).toEqual({ provider: 'tinfoil', model: 'glm-5-2' })
    expect(inferenceUsageReceiptPath).toBe('inference-usage/receipts')
  })

  it('keeps the shipped system GLM model aligned with the canonical identity', () => {
    expect(defaultModelGlm52).toMatchObject({
      ...managedGlmIdentity,
      isSystem: 1,
    })
  })
})
