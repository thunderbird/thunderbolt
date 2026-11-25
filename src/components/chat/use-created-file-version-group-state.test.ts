/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useCreatedFileVersionGroupState } from './use-created-file-version-group-state'

describe('useCreatedFileVersionGroupState', () => {
  it('starts collapsed and toggles open and closed', () => {
    const { result } = renderHook(() => useCreatedFileVersionGroupState())
    expect(result.current.expanded).toBe(false)
    act(() => result.current.toggle())
    expect(result.current.expanded).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.expanded).toBe(false)
  })
})
