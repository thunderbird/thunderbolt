import { useReducer } from 'react'

type DropdownState = {
  temperature: boolean
  windSpeed: boolean
  precipitation: boolean
  timeFormat: boolean
  distance: boolean
}

type DropdownAction =
  | { type: 'TOGGLE_TEMPERATURE' }
  | { type: 'TOGGLE_WIND_SPEED' }
  | { type: 'TOGGLE_PRECIPITATION' }
  | { type: 'TOGGLE_TIME_FORMAT' }
  | { type: 'TOGGLE_DISTANCE' }
  | { type: 'SET_DROPDOWN'; payload: { dropdown: keyof DropdownState; open: boolean } }

const initialState: DropdownState = {
  temperature: false,
  windSpeed: false,
  precipitation: false,
  timeFormat: false,
  distance: false,
}

const dropdownReducer = (state: DropdownState, action: DropdownAction): DropdownState => {
  switch (action.type) {
    case 'TOGGLE_TEMPERATURE':
      return { ...state, temperature: !state.temperature }
    case 'TOGGLE_WIND_SPEED':
      return { ...state, windSpeed: !state.windSpeed }
    case 'TOGGLE_PRECIPITATION':
      return { ...state, precipitation: !state.precipitation }
    case 'TOGGLE_TIME_FORMAT':
      return { ...state, timeFormat: !state.timeFormat }
    case 'TOGGLE_DISTANCE':
      return { ...state, distance: !state.distance }
    case 'SET_DROPDOWN':
      return { ...state, [action.payload.dropdown]: action.payload.open }
    default:
      return state
  }
}

/**
 * Manages dropdown open/close states for localization settings
 * Uses useReducer to follow the "3+ useState hooks" rule
 */
export const useLocalizationDropdowns = () => {
  const [state, dispatch] = useReducer(dropdownReducer, initialState)

  return {
    // State
    temperatureDropdownOpen: state.temperature,
    windSpeedDropdownOpen: state.windSpeed,
    precipitationDropdownOpen: state.precipitation,
    timeFormatDropdownOpen: state.timeFormat,
    distanceDropdownOpen: state.distance,

    // Actions
    setTemperatureDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'temperature', open } }),
    setWindSpeedDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'windSpeed', open } }),
    setPrecipitationDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'precipitation', open } }),
    setTimeFormatDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'timeFormat', open } }),
    setDistanceDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'distance', open } }),
  }
}
