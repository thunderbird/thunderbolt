/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { ThunderboltUIMessage } from '@/types'
import type { SourceMetadata } from '@/types/source'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { useThreadSources } from './use-thread-sources'

const makeSource = (index: number): SourceMetadata => ({
  index,
  url: `https://example.com/${index}`,
  title: `Source ${index}`,
  toolName: 'search',
})

const user = (id: string): ThunderboltUIMessage => ({ id, role: 'user', parts: [] })
const assistant = (id: string, sources?: SourceMetadata[]): ThunderboltUIMessage => ({
  id,
  role: 'assistant',
  parts: [],
  metadata: sources ? { sources } : undefined,
})

afterEach(cleanup)

describe('useThreadSources', () => {
  it('gives each assistant message its own sources plus every earlier turn’s', () => {
    const turnOne = [makeSource(1), makeSource(2)]
    const turnThree = [makeSource(3)]
    const messages = [
      user('u1'),
      assistant('a1', turnOne),
      user('u2'),
      assistant('a2'),
      user('u3'),
      assistant('a3', turnThree),
    ]

    const { result } = renderHook(() => useThreadSources(messages))

    expect(result.current.get('a1')).toBe(turnOne)
    expect(result.current.get('a2')).toBe(turnOne)
    expect(result.current.get('a3')).toEqual([...turnOne, ...turnThree])
    expect(result.current.has('u1')).toBe(false)
  })

  it('does not let a message see sources from later turns', () => {
    const later = [makeSource(1)]
    const messages = [assistant('a1'), assistant('a2', later)]

    const { result } = renderHook(() => useThreadSources(messages))

    expect(result.current.get('a1')).toBeUndefined()
    expect(result.current.get('a2')).toBe(later)
  })

  it('keeps settled messages’ arrays referentially stable while the last message streams', () => {
    const turnOne = [makeSource(1)]
    const first = [user('u1'), assistant('a1', turnOne), user('u2'), assistant('a2', [makeSource(2)])]
    const { result, rerender } = renderHook(({ messages }) => useThreadSources(messages), {
      initialProps: { messages: first },
    })
    const settledBefore = result.current.get('a1')
    const streamingBefore = result.current.get('a2')

    const streamed = [...first.slice(0, 3), assistant('a2', [makeSource(2), makeSource(3)])]
    rerender({ messages: streamed })

    expect(result.current.get('a1')).toBe(settledBefore)
    expect(result.current.get('a2')).not.toBe(streamingBefore)
    expect(result.current.get('a2')).toEqual([makeSource(1), makeSource(2), makeSource(3)])
  })

  it('recomputes a later message when an earlier one gains sources', () => {
    const first = [assistant('a1'), assistant('a2', [makeSource(5)])]
    const { result, rerender } = renderHook(({ messages }) => useThreadSources(messages), {
      initialProps: { messages: first },
    })
    expect(result.current.get('a2')).toEqual([makeSource(5)])

    rerender({ messages: [assistant('a1', [makeSource(1)]), first[1]] })

    expect(result.current.get('a2')).toEqual([makeSource(1), makeSource(5)])
  })
})
