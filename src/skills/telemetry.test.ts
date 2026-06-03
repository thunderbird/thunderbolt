/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { hashSkillId } from './telemetry'

describe('hashSkillId', () => {
  it('returns a deterministic 16-char hex string', async () => {
    const a = await hashSkillId('user-1', 'skill-1')
    const b = await hashSkillId('user-1', 'skill-1')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces different hashes for different user_ids on the same skill (unlinkability)', async () => {
    const a = await hashSkillId('user-1', 'shared-skill')
    const b = await hashSkillId('user-2', 'shared-skill')
    expect(a).not.toBe(b)
  })

  it('produces different hashes for different skill_ids under the same user', async () => {
    const a = await hashSkillId('user-1', 'skill-a')
    const b = await hashSkillId('user-1', 'skill-b')
    expect(a).not.toBe(b)
  })
})
