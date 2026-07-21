/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { isReadOnlyAgentTool, resolveToolPermission, toAcpToolKind } from './agent-tool-permissions.ts'

const options = [
  { optionId: 'once', name: 'Once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always', kind: 'allow_always' },
  { optionId: 'no', name: 'No', kind: 'reject_once' },
] as const

describe('agent tool permission policy', () => {
  it('only classifies read as read-only', () => {
    expect(isReadOnlyAgentTool('read')).toBe(true)
    expect(isReadOnlyAgentTool('bash')).toBe(false)
    expect(isReadOnlyAgentTool('unknown')).toBe(false)
  })

  it('maps coding tools to ACP kinds', () => {
    expect(['bash', 'read', 'write', 'edit', 'unknown'].map(toAcpToolKind)).toEqual([
      'execute',
      'read',
      'edit',
      'edit',
      'other',
    ])
  })

  it('resolves allows, rejections, cancellation, and unknown ids', () => {
    expect(resolveToolPermission({ outcome: 'selected', optionId: 'once' }, options)).toBe('allow-once')
    expect(resolveToolPermission({ outcome: 'selected', optionId: 'always' }, options)).toBe('allow-always')
    expect(resolveToolPermission({ outcome: 'selected', optionId: 'no' }, options)).toBe('reject')
    expect(resolveToolPermission({ outcome: 'cancelled' }, options)).toBe('reject')
    expect(resolveToolPermission({ outcome: 'selected', optionId: 'missing' }, options)).toBe('reject')
  })
})
