import { useHttpClient } from '@/contexts'
import { useDebounce } from '@/hooks/use-debounce'
import { useEffect, useReducer } from 'react'

type LocationData = {
  name: string
  city: string
  coordinates: {
    lat: number
    lng: number
  }
}

type LocationState = {
  open: boolean
  searchQuery: string
  locations: LocationData[]
  isSearching: boolean
}

type LocationAction =
  | { type: 'SET_OPEN'; payload: boolean }
  | { type: 'SET_SEARCH_QUERY'; payload: string }
  | { type: 'SET_LOCATIONS'; payload: LocationData[] }
  | { type: 'SET_IS_SEARCHING'; payload: boolean }
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
      return { ...state, searchQuery: action.payload }
    case 'SET_LOCATIONS':
      return { ...state, locations: action.payload }
    case 'SET_IS_SEARCHING':
      return { ...state, isSearching: action.payload }
    case 'CLEAR_LOCATION_SEARCH':
      return { ...state, searchQuery: '', locations: [] }
    default:
      return state
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
  const [locationState, dispatch] = useReducer(locationReducer, createInitialState(autoOpen))
  const { open, searchQuery, locations, isSearching } = locationState
  const debouncedSearchQuery = useDebounce(searchQuery, 300)

  useEffect(() => {
    const searchLocations = async () => {
      if (debouncedSearchQuery.trim().length <= 1) {
        dispatch({ type: 'SET_LOCATIONS', payload: [] })
        return
      }

      dispatch({ type: 'SET_IS_SEARCHING', payload: true })
      try {
        const data = await httpClient
          .get('locations', {
            searchParams: { query: debouncedSearchQuery },
          })
          .json<
            Array<{
              name: string
              region: string
              country: string
              lat: number
              lon: number
            }>
          >()

        const transformedLocations: LocationData[] = data.map((location) => ({
          name: `${location.name}, ${location.region}, ${location.country}`,
          city: location.name,
          coordinates: {
            lat: location.lat,
            lng: location.lon,
          },
        }))
        dispatch({ type: 'SET_LOCATIONS', payload: transformedLocations })
      } catch (error) {
        console.error('Error searching locations:', error)
        dispatch({ type: 'SET_LOCATIONS', payload: [] })
      } finally {
        dispatch({ type: 'SET_IS_SEARCHING', payload: false })
      }
    }

    searchLocations()
  }, [debouncedSearchQuery, httpClient])

  const setOpen = (open: boolean) => dispatch({ type: 'SET_OPEN', payload: open })
  const setSearchQuery = (query: string) => dispatch({ type: 'SET_SEARCH_QUERY', payload: query })
  const clearSearch = () => dispatch({ type: 'CLEAR_LOCATION_SEARCH' })

  return {
    open,
    searchQuery,
    locations,
    isSearching,
    setOpen,
    setSearchQuery,
    clearSearch,
  }
}

export type { LocationData }
