/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for {@link workspaceDirFor} — the per-thread workspace path that is
 * ALSO the coding-tool jail boundary. A threadId carrying `/` or `..` would move
 * that boundary and defeat per-thread isolation, so the function must reject any
 * non-UUID-shaped id loudly. Only the pure, security-relevant path logic is tested
 * here; the rest of `buildAppHarness` is ZenFS/OPFS wiring covered by integration.
 */

import { describe, expect, it } from 'bun:test'
import { workspaceDirFor } from './build-app-harness.ts'

describe('workspaceDirFor', () => {
  it('roots a UUID-shaped thread under /workspace', () => {
    expect(workspaceDirFor('3cc2bf39-afa2-44d1-a89b-a1ecec7bb067')).toBe(
      '/workspace/3cc2bf39-afa2-44d1-a89b-a1ecec7bb067',
    )
  })

  it('allows the dot/underscore/hyphen characters that may appear in ids', () => {
    expect(workspaceDirFor('a.b_c-D9')).toBe('/workspace/a.b_c-D9')
  })

  it.each([
    ['contains a slash', 'a/b'],
    ['is a parent-traversal segment', '..'],
    ['is the current-dir segment', '.'],
    ['embeds a traversal path', '../../etc'],
    ['contains a backslash-style separator attempt', 'a\\b'],
    ['contains whitespace', 'a b'],
    ['is empty', ''],
  ])('throws when the threadId %s', (_why, threadId) => {
    expect(() => workspaceDirFor(threadId)).toThrow(/unsafe threadId/)
  })
})
