/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, test } from 'bun:test'
import { usePendingQuotesStore } from './pending-quotes-store'

const { getState, setState } = usePendingQuotesStore

afterEach(() => setState({ quotesByThread: {} }))

describe('pending-quotes-store', () => {
  test('addQuote appends per thread without touching other threads', () => {
    getState().addQuote('t1', { text: 'a' })
    getState().addQuote('t1', { text: 'b' })
    getState().addQuote('t2', { text: 'c' })
    expect(getState().quotesByThread.t1.map((q) => q.data.text)).toEqual(['a', 'b'])
    expect(getState().quotesByThread.t2.map((q) => q.data.text)).toEqual(['c'])
  })

  test('addQuote assigns each pending quote a distinct stable id', () => {
    getState().addQuote('t1', { text: 'a' })
    getState().addQuote('t1', { text: 'a' })
    const [first, second] = getState().quotesByThread.t1
    expect(first.id).not.toBe(second.id)
  })

  test('removeQuote drops the passage with the matching id', () => {
    getState().setQuotes('t1', [{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    const middleId = getState().quotesByThread.t1[1].id
    getState().removeQuote('t1', middleId)
    expect(getState().quotesByThread.t1.map((q) => q.data.text)).toEqual(['a', 'c'])
  })

  test('clearQuotes removes the thread entry entirely', () => {
    getState().setQuotes('t1', [{ text: 'a' }])
    getState().clearQuotes('t1')
    expect(getState().quotesByThread.t1).toBeUndefined()
  })
})
