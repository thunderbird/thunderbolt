/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { findPlaintextViolation } from './encrypted-payload'

const ciphertext = '__enc:v2:0:aXYtYmFzZTY0:Y3QtYmFzZTY0'
const legacyCiphertext = '__enc:aXYtYmFzZTY0:Y3QtYmFzZTY0'

describe('findPlaintextViolation', () => {
  it('rejects plaintext in an encrypted column', () => {
    const violation = findPlaintextViolation([{ op: 'PATCH', type: 'tasks', id: 'row-1', data: { item: 'buy milk' } }])

    expect(violation).toEqual({ table: 'tasks', id: 'row-1', column: 'item' })
  })

  it('accepts v2 ciphertext', () => {
    const violation = findPlaintextViolation([{ op: 'PUT', type: 'tasks', id: 'row-1', data: { item: ciphertext } }])

    expect(violation).toBeNull()
  })

  it('accepts ciphertext under a rotated key_id', () => {
    const rotated = '__enc:v2:1:aXYtYmFzZTY0:Y3QtYmFzZTY0'
    const violation = findPlaintextViolation([{ op: 'PUT', type: 'tasks', id: 'row-1', data: { item: rotated } }])

    expect(violation).toBeNull()
  })

  it('rejects legacy v1 ciphertext on a migrated account', () => {
    // A v2 account must never accept a v1 write — that is the hard cutover.
    const violation = findPlaintextViolation([
      { op: 'PUT', type: 'tasks', id: 'row-1', data: { item: legacyCiphertext } },
    ])

    expect(violation).toEqual({ table: 'tasks', id: 'row-1', column: 'item' })
  })

  it('ignores columns that are not configured as encrypted', () => {
    const violation = findPlaintextViolation([
      { op: 'PATCH', type: 'tasks', id: 'row-1', data: { completed: true, sort_order: 3 } },
    ])

    expect(violation).toBeNull()
  })

  it('ignores tables with no encrypted columns', () => {
    const violation = findPlaintextViolation([{ op: 'PUT', type: 'agents', id: 'a-1', data: { name: 'plain' } }])

    expect(violation).toBeNull()
  })

  it('ignores non-string values, which are never encryptable', () => {
    const violation = findPlaintextViolation([
      { op: 'PATCH', type: 'tasks', id: 'row-1', data: { item: null } },
      { op: 'PATCH', type: 'settings', id: 's-1', data: { value: 42 } },
    ])

    expect(violation).toBeNull()
  })

  it('ignores DELETE operations', () => {
    const violation = findPlaintextViolation([{ op: 'DELETE', type: 'tasks', id: 'row-1', data: { item: 'buy milk' } }])

    expect(violation).toBeNull()
  })

  it('ignores operations with no data', () => {
    const violation = findPlaintextViolation([{ op: 'PATCH', type: 'tasks', id: 'row-1' }])

    expect(violation).toBeNull()
  })

  it('reports the first violation across a mixed batch', () => {
    const violation = findPlaintextViolation([
      { op: 'PUT', type: 'tasks', id: 'row-1', data: { item: ciphertext } },
      { op: 'PATCH', type: 'chat_threads', id: 'thread-1', data: { title: 'My chat' } },
      { op: 'PATCH', type: 'settings', id: 's-1', data: { value: 'also plaintext' } },
    ])

    expect(violation).toEqual({ table: 'chat_threads', id: 'thread-1', column: 'title' })
  })

  it('checks every configured column of a multi-column table', () => {
    const violation = findPlaintextViolation([
      {
        op: 'PUT',
        type: 'chat_messages',
        id: 'm-1',
        data: { content: ciphertext, parts: ciphertext, metadata: 'leaked' },
      },
    ])

    expect(violation).toEqual({ table: 'chat_messages', id: 'm-1', column: 'metadata' })
  })

  it('accepts an empty batch', () => {
    expect(findPlaintextViolation([])).toBeNull()
  })
})
