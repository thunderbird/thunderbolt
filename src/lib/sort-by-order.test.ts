/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { sortByOrder } from './sort-by-order'

describe('sortByOrder', () => {
  it('sorts items according to specified order', () => {
    const items = ['cherry', 'apple', 'banana']
    const order = ['apple', 'banana', 'cherry']

    const result = sortByOrder(items, order, (item) => item)

    expect(result).toEqual(['apple', 'banana', 'cherry'])
  })

  it('places unordered items at the end alphabetically', () => {
    const items = ['zebra', 'apple', 'mango', 'banana']
    const order = ['apple', 'banana']

    const result = sortByOrder(items, order, (item) => item)

    expect(result).toEqual(['apple', 'banana', 'mango', 'zebra'])
  })

  it('handles items not in the order list', () => {
    const items = ['delta', 'charlie', 'bravo', 'alpha']
    const order = ['alpha', 'bravo']

    const result = sortByOrder(items, order, (item) => item)

    expect(result).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
  })

  it('handles empty order list', () => {
    const items = ['cherry', 'apple', 'banana']
    const order: string[] = []

    const result = sortByOrder(items, order, (item) => item)

    expect(result).toEqual(['apple', 'banana', 'cherry'])
  })

  it('handles empty items list', () => {
    const items: string[] = []
    const order = ['apple', 'banana']

    const result = sortByOrder(items, order, (item) => item)

    expect(result).toEqual([])
  })

  it('handles order items that do not exist in items list', () => {
    const items = ['cherry', 'apple']
    const order = ['banana', 'apple', 'mango', 'cherry']

    const result = sortByOrder(items, order, (item) => item)

    expect(result).toEqual(['apple', 'cherry'])
  })

  it('works with objects using a key extractor', () => {
    const items = [
      { id: 1, name: 'cherry' },
      { id: 2, name: 'apple' },
      { id: 3, name: 'banana' },
    ]
    const order = ['apple', 'banana', 'cherry']

    const result = sortByOrder(items, order, (item) => item.name)

    expect(result).toEqual([
      { id: 2, name: 'apple' },
      { id: 3, name: 'banana' },
      { id: 1, name: 'cherry' },
    ])
  })

  it('does not mutate the original array', () => {
    const items = ['cherry', 'apple', 'banana']
    const original = [...items]
    const order = ['apple', 'banana', 'cherry']

    sortByOrder(items, order, (item) => item)

    expect(items).toEqual(original)
  })

  it('handles duplicate items correctly', () => {
    const items = ['apple', 'cherry', 'apple', 'banana']
    const order = ['apple', 'banana', 'cherry']

    const result = sortByOrder(items, order, (item) => item)

    expect(result).toEqual(['apple', 'apple', 'banana', 'cherry'])
  })
})
