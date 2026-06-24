/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { RegistryEntry } from '@/types/registry'
import { useAgentRegistrySearch } from './use-agent-registry-search'

const entry = (id: string, name: string, description: string): RegistryEntry => ({
  id,
  name,
  description,
  version: '1.0.0',
  authors: ['Author'],
  license: 'Apache-2.0',
  distribution: { npx: { package: `${id}@1.0.0` } },
})

const entries: ReadonlyArray<RegistryEntry> = [
  entry('goose', 'goose', 'Extensible agent from Block'),
  entry('gemini', 'Gemini CLI', 'Google terminal agent'),
]

describe('useAgentRegistrySearch', () => {
  it('returns all entries with an empty query', () => {
    const { result } = renderHook(() => useAgentRegistrySearch(entries))
    expect(result.current.results).toEqual(entries)
    expect(result.current.isEmpty).toBe(false)
  })

  it('returns all entries for a whitespace-only query', () => {
    const { result } = renderHook(() => useAgentRegistrySearch(entries))

    act(() => {
      result.current.setQuery('   ')
    })

    expect(result.current.results).toEqual(entries)
    expect(result.current.isEmpty).toBe(false)
  })

  it('derives results as the query changes', () => {
    const { result } = renderHook(() => useAgentRegistrySearch(entries))

    act(() => {
      result.current.setQuery('gemini')
    })

    expect(result.current.results).toHaveLength(1)
    expect(result.current.results[0]?.id).toBe('gemini')
    expect(result.current.isEmpty).toBe(false)
  })

  it('is empty when nothing matches', () => {
    const { result } = renderHook(() => useAgentRegistrySearch(entries))

    act(() => {
      result.current.setQuery('zzzqqqxx')
    })

    expect(result.current.results).toEqual([])
    expect(result.current.isEmpty).toBe(true)
  })
})
