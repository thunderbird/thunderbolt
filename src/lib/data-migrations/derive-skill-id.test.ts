/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'

import { deriveSkillIdFromAutomationId } from './derive-skill-id'

describe('deriveSkillIdFromAutomationId', () => {
  it('returns a UUID-shaped string', async () => {
    const id = await deriveSkillIdFromAutomationId('automation-1')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('is deterministic — same input always produces the same output', async () => {
    const a = await deriveSkillIdFromAutomationId('automation-1')
    const b = await deriveSkillIdFromAutomationId('automation-1')
    expect(a).toBe(b)
  })

  it('produces different ids for different automations', async () => {
    const a = await deriveSkillIdFromAutomationId('automation-1')
    const b = await deriveSkillIdFromAutomationId('automation-2')
    expect(a).not.toBe(b)
  })
})
