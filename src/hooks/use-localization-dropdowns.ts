import { useReducer } from 'react'

type DropdownState = {
  distance: boolean
  temperature: boolean
  dateFormat: boolean
  timeFormat: boolean
  currency: boolean
}

type DropdownAction =
  | { type: 'TOGGLE_DISTANCE' }
  | { type: 'TOGGLE_TEMPERATURE' }
  | { type: 'TOGGLE_DATE_FORMAT' }
  | { type: 'TOGGLE_TIME_FORMAT' }
  | { type: 'TOGGLE_CURRENCY' }
  | { type: 'SET_DROPDOWN'; payload: { dropdown: keyof DropdownState; open: boolean } }

export const initialState: DropdownState = {
  distance: false,
  temperature: false,
  dateFormat: false,
  timeFormat: false,
  currency: false,
}

export const dropdownReducer = (state: DropdownState, action: DropdownAction): DropdownState => {
  switch (action.type) {
    case 'TOGGLE_DISTANCE':
      return { ...state, distance: !state.distance }
    case 'TOGGLE_TEMPERATURE':
      return { ...state, temperature: !state.temperature }
    case 'TOGGLE_DATE_FORMAT':
      return { ...state, dateFormat: !state.dateFormat }
    case 'TOGGLE_TIME_FORMAT':
      return { ...state, timeFormat: !state.timeFormat }
    case 'TOGGLE_CURRENCY':
      return { ...state, currency: !state.currency }
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
    distanceDropdownOpen: state.distance,
    temperatureDropdownOpen: state.temperature,
    dateFormatDropdownOpen: state.dateFormat,
    timeFormatDropdownOpen: state.timeFormat,
    currencyDropdownOpen: state.currency,

    setDistanceDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'distance', open } }),
    setTemperatureDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'temperature', open } }),
    setDateFormatDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'dateFormat', open } }),
    setTimeFormatDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'timeFormat', open } }),
    setCurrencyDropdownOpen: (open: boolean) =>
      dispatch({ type: 'SET_DROPDOWN', payload: { dropdown: 'currency', open } }),
  }
}
