/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The set of entity kinds surfaced by global search (THU-766). */
export type SearchEntityType = 'chat' | 'message' | 'model' | 'skill' | 'agent' | 'mcp' | 'device' | 'task' | 'project'

/** A single ranked hit rendered in the command palette. */
export type SearchResult = {
  id: string
  entityType: SearchEntityType
  title: string
  snippet: string
  /** Router path to navigate to when the result is selected. */
  to: string
}

/** Hook contract every search consumer keys off. */
export type UseSearch = (query: string) => {
  results: SearchResult[]
  isLoading: boolean
}
