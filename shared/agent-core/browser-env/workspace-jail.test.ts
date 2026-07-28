/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `workspace-jail` tests — the single guard every browser coding tool uses to keep
 * a thread's file/shell access inside its own `/workspace/<threadId>` subtree.
 */

import { describe, expect, it } from 'bun:test'
import { isWithinWorkspace, resolveInWorkspace } from './workspace-jail.ts'

const ws = '/workspace/thread-1'

describe('resolveInWorkspace', () => {
  it('resolves a relative path inside the workspace', () => {
    expect(resolveInWorkspace(ws, 'notes/todo.md')).toBe(`${ws}/notes/todo.md`)
  })

  it('allows the workspace root itself', () => {
    expect(resolveInWorkspace(ws, '.')).toBe(ws)
  })

  it('throws on an absolute path outside the workspace', () => {
    expect(() => resolveInWorkspace(ws, '/etc/passwd')).toThrow('path escapes workspace')
  })

  it('throws on a `..` traversal into a sibling thread', () => {
    expect(() => resolveInWorkspace(ws, '../thread-2/secret')).toThrow('path escapes workspace')
  })

  it('throws on a `..` chain that climbs above the workspace root', () => {
    expect(() => resolveInWorkspace(ws, 'a/../../thread-2/x')).toThrow('path escapes workspace')
  })

  it('does not treat a sibling whose name shares a prefix as inside', () => {
    expect(() => resolveInWorkspace(ws, '/workspace/thread-12/x')).toThrow('path escapes workspace')
  })
})

describe('isWithinWorkspace', () => {
  it('accepts the root and its descendants', () => {
    expect(isWithinWorkspace(ws, ws)).toBe(true)
    expect(isWithinWorkspace(ws, `${ws}/a/b`)).toBe(true)
  })

  it('rejects siblings and prefix-aliased siblings', () => {
    expect(isWithinWorkspace(ws, '/workspace/thread-2')).toBe(false)
    expect(isWithinWorkspace(ws, '/workspace/thread-1-evil')).toBe(false)
  })
})
