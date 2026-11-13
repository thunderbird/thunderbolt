/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as analytics from '@/lib/posthog'
import { trackSkillEvent } from './telemetry'

describe('skill telemetry', () => {
  afterEach(() => {
    trackSpy.mockRestore()
  })
  let trackSpy: ReturnType<typeof spyOn<typeof analytics, 'trackEvent'>>

  it('records usage without needing an auth session or a skill identity', () => {
    trackSpy = spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    trackSkillEvent('skill_used', { via: 'chip' })
    trackSkillEvent('skill_created', { instruction_length: 100 })
    expect(trackSpy.mock.calls).toEqual([
      ['skill_used', { via: 'chip' }],
      ['skill_created', { instruction_length: 100 }],
    ])
  })
})
