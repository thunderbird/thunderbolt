/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const searchProviders = {
  exa: { name: 'Exa', keyUrl: 'https://dashboard.exa.ai/api-keys' },
  brave: { name: 'Brave', keyUrl: 'https://brave.com/search/api/' },
  tavily: { name: 'Tavily', keyUrl: 'https://app.tavily.com/' },
} as const

export type SearchProvider = keyof typeof searchProviders

/** Validates persisted or UI-provided search provider identifiers. */
export const isSearchProvider = (value: string): value is SearchProvider => Object.hasOwn(searchProviders, value)
