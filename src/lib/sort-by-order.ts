/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Sort items according to a predefined order.
 * Items in the order list come first (in that order), others follow alphabetically.
 *
 * @param items - Array of items to sort
 * @param order - Array of keys defining the desired order
 * @param getKey - Function to extract the sort key from each item
 * @returns New sorted array (does not mutate original)
 */
export const sortByOrder = <T>(items: T[], order: string[], getKey: (item: T) => string): T[] => {
  return [...items].sort((a, b) => {
    const keyA = getKey(a)
    const keyB = getKey(b)
    const indexA = order.indexOf(keyA)
    const indexB = order.indexOf(keyB)

    // Both in the order list: sort by their position
    if (indexA !== -1 && indexB !== -1) {
      return indexA - indexB
    }
    // Only a is in the order list: a comes first
    if (indexA !== -1) {
      return -1
    }
    // Only b is in the order list: b comes first
    if (indexB !== -1) {
      return 1
    }
    // Neither in the order list: sort alphabetically by key
    return keyA.localeCompare(keyB)
  })
}
