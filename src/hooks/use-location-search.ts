/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts'
import { useDebounce } from '@/hooks/use-debounce'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { fetchLocations, type LocationData } from '@/lib/locations'
import { useEffect, useReducer } from 'react'

type LocationState = {
  open: boolean
  searchQuery: string
  locations: LocationData[]
  isSearching: boolean
}

type LocationAction =
  | { type: 'SET_OPEN'; payload: boolean }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SEARCH_STARTED' }
  | { type: 'SEARCH_SETTLED'; payload: LocationData[] }
  | { type: 'CLEAR_LOCATION_SEARCH' }

const createInitialState = (autoOpen = false): LocationState => ({
  open: autoOpen,
  searchQuery: '',
  locations: [],
  isSearching: false,
})

const locationReducer = (state: LocationState, action: LocationAction): LocationState => {
  switch (action.type) {
    case 'SET_OPEN':
      return { ...state, open: action.payload }
    case 'SET_SEARCH_QUERY':
      if (state.searchQuery === action.payload) {
        return state
      }
      return { ...state, searchQuery: action.payload, locations: [], isSearching: false }
    case 'SEARCH_STARTED':
      return { ...state, locations: [], isSearching: true }
    case 'SEARCH_SETTLED':
      return { ...state, locations: action.payload, isSearching: false }
    case 'CLEAR_LOCATION_SEARCH':
      return { ...state, searchQuery: '', locations: [], isSearching: false }
  }
}

type UseLocationSearchOptions = {
  autoOpen?: boolean
}

/**
 * Custom hook for location search functionality
 */
export const useLocationSearch = ({ autoOpen }: UseLocationSearchOptions = {}) => {
  const httpClient = useHttpClient()
  const locale = useActiveLocale()
  const [locationState, dispatch] = useReducer(locationReducer, createInitialState(autoOpen))
  const { open, searchQuery, locations, isSearching } = locationState
  const debouncedSearchQuery = useDebounce(searchQuery, 300)

  useEffect(() => {
    // Invalidate immediately on input changes, including during the debounce.
    if (searchQuery !== debouncedSearchQuery || searchQuery.trim().length <= 1) {
      return
    }
    let cancelled = false
    dispatch({ type: 'SEARCH_STARTED' })
    const search = async () => {
      try {
        const results = await fetchLocations(httpClient, searchQuery, locale)
        if (!cancelled) {
          dispatch({ type: 'SEARCH_SETTLED', payload: results })
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Error searching locations:', error)
          dispatch({ type: 'SEARCH_SETTLED', payload: [] })
        }
      }
    }
    void search()
    return () => {
      cancelled = true
    }
  }, [searchQuery, debouncedSearchQuery, httpClient, locale])

  const setOpen = (open: boolean) => dispatch({ type: 'SET_OPEN', payload: open })
  const setSearchQuery = (query: string) => dispatch({ type: 'SET_SEARCH_QUERY', payload: query })
  const clearSearch = () => dispatch({ type: 'CLEAR_LOCATION_SEARCH' })

  const isPending = searchQuery !== debouncedSearchQuery

  return {
    open,
    searchQuery,
    locations,
    isSearching,
    isPending,
    setOpen,
    setSearchQuery,
    clearSearch,
  }
}

export type { LocationData }
