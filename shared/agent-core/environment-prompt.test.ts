/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { APP_HARNESS_ENVIRONMENT_PROMPT, withAppEnvironmentPrompt } from './environment-prompt.ts'

describe('withAppEnvironmentPrompt', () => {
  it('appends the app environment to the current caller-supplied prompt', async () => {
    const systemPrompt = { current: 'initial prompt' }
    const effectiveSystemPrompt = withAppEnvironmentPrompt(() => systemPrompt.current)

    expect(typeof effectiveSystemPrompt).toBe('function')
    if (typeof effectiveSystemPrompt !== 'function') {
      throw new Error('expected dynamic system prompt')
    }

    expect(await effectiveSystemPrompt({} as never)).toBe(`initial prompt\n\n${APP_HARNESS_ENVIRONMENT_PROMPT}`)

    systemPrompt.current = 'refreshed prompt'
    expect(await effectiveSystemPrompt({} as never)).toBe(`refreshed prompt\n\n${APP_HARNESS_ENVIRONMENT_PROMPT}`)
  })

  it('appends the app environment to a static prompt', () => {
    expect(withAppEnvironmentPrompt('static prompt')).toBe(`static prompt\n\n${APP_HARNESS_ENVIRONMENT_PROMPT}`)
  })
})
