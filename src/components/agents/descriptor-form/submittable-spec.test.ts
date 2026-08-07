/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import type { AgentDescriptor } from '@shared/agent-descriptors'
import { submittableSpec } from './submittable-spec'

const descriptor: AgentDescriptor = {
  id: 'x',
  provider: 'x',
  name: 'X',
  description: null,
  icon: null,
  schemaVersion: 1,
  action: 'deploy',
  steps: [
    {
      id: 's',
      title: 'S',
      fields: [
        { key: 'name', label: 'Name', widget: 'text' },
        { key: 'mode', label: 'Mode', widget: 'text' },
        { key: 'apiKey', label: 'API key', widget: 'password', visibleWhen: { field: 'mode', equals: 'byo' } },
      ],
    },
  ],
}

describe('submittableSpec', () => {
  it('keeps only visible fields with defined values', () => {
    expect(submittableSpec(descriptor, { name: 'Bot', mode: 'curated' })).toEqual({ name: 'Bot', mode: 'curated' })
  })

  it('drops a hidden field even if it holds a value', () => {
    // mode=curated hides apiKey — its stale value must not be submitted.
    expect(submittableSpec(descriptor, { name: 'Bot', mode: 'curated', apiKey: 'sk-1' })).toEqual({
      name: 'Bot',
      mode: 'curated',
    })
  })

  it('includes a conditionally-shown field once its guard matches', () => {
    expect(submittableSpec(descriptor, { name: 'Bot', mode: 'byo', apiKey: 'sk-1' })).toEqual({
      name: 'Bot',
      mode: 'byo',
      apiKey: 'sk-1',
    })
  })

  it('ignores keys not present in the descriptor and undefined values', () => {
    expect(submittableSpec(descriptor, { name: 'Bot', mode: undefined, bogus: 'x' } as never)).toEqual({ name: 'Bot' })
  })
})
