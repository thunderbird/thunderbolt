import { describe, it, expect } from 'bun:test'
import { dropdownReducer, initialState } from './use-localization-dropdowns'

// Test the reducer directly since it contains the core logic
describe('useLocalizationDropdowns', () => {
  describe('dropdownReducer', () => {
    it('should initialize with all dropdowns closed', () => {
      expect(initialState).toEqual({
        temperature: false,
        windSpeed: false,
        precipitation: false,
        timeFormat: false,
        distance: false,
      })
    })

    it('should toggle temperature dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_TEMPERATURE' })
      expect(state.temperature).toBe(true)
      expect(state.windSpeed).toBe(false)
      expect(state.precipitation).toBe(false)
      expect(state.timeFormat).toBe(false)
      expect(state.distance).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_TEMPERATURE' })
      expect(newState.temperature).toBe(false)
    })

    it('should toggle wind speed dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_WIND_SPEED' })
      expect(state.windSpeed).toBe(true)
      expect(state.temperature).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_WIND_SPEED' })
      expect(newState.windSpeed).toBe(false)
    })

    it('should toggle precipitation dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_PRECIPITATION' })
      expect(state.precipitation).toBe(true)
      expect(state.temperature).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_PRECIPITATION' })
      expect(newState.precipitation).toBe(false)
    })

    it('should toggle time format dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_TIME_FORMAT' })
      expect(state.timeFormat).toBe(true)
      expect(state.temperature).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_TIME_FORMAT' })
      expect(newState.timeFormat).toBe(false)
    })

    it('should toggle distance dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_DISTANCE' })
      expect(state.distance).toBe(true)
      expect(state.temperature).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_DISTANCE' })
      expect(newState.distance).toBe(false)
    })

    it('should set dropdown state with SET_DROPDOWN action', () => {
      const state = dropdownReducer(initialState, {
        type: 'SET_DROPDOWN',
        payload: { dropdown: 'temperature', open: true },
      })
      expect(state.temperature).toBe(true)
      expect(state.windSpeed).toBe(false)

      const newState = dropdownReducer(state, {
        type: 'SET_DROPDOWN',
        payload: { dropdown: 'temperature', open: false },
      })
      expect(newState.temperature).toBe(false)
    })

    it('should handle SET_DROPDOWN for all dropdown types', () => {
      const dropdowns = ['temperature', 'windSpeed', 'precipitation', 'timeFormat', 'distance'] as const

      dropdowns.forEach((dropdown) => {
        const state = dropdownReducer(initialState, {
          type: 'SET_DROPDOWN',
          payload: { dropdown, open: true },
        })
        expect(state[dropdown]).toBe(true)

        const newState = dropdownReducer(state, {
          type: 'SET_DROPDOWN',
          payload: { dropdown, open: false },
        })
        expect(newState[dropdown]).toBe(false)
      })
    })

    it('should maintain independent state for each dropdown', () => {
      let state = dropdownReducer(initialState, { type: 'TOGGLE_TEMPERATURE' })
      state = dropdownReducer(state, { type: 'TOGGLE_WIND_SPEED' })

      expect(state.temperature).toBe(true)
      expect(state.windSpeed).toBe(true)
      expect(state.precipitation).toBe(false)
      expect(state.timeFormat).toBe(false)
      expect(state.distance).toBe(false)
    })

    it('should handle rapid state changes', () => {
      let state = initialState

      state = dropdownReducer(state, { type: 'TOGGLE_TEMPERATURE' })
      state = dropdownReducer(state, { type: 'TOGGLE_TEMPERATURE' })
      state = dropdownReducer(state, { type: 'TOGGLE_TEMPERATURE' })

      expect(state.temperature).toBe(true)
    })

    it('should return same state for unknown action', () => {
      const state = dropdownReducer(initialState, { type: 'UNKNOWN_ACTION' } as any)
      expect(state).toEqual(initialState)
    })

    it('should preserve other dropdown states when toggling one', () => {
      let state = dropdownReducer(initialState, { type: 'TOGGLE_TEMPERATURE' })
      state = dropdownReducer(state, { type: 'TOGGLE_WIND_SPEED' })

      state = dropdownReducer(state, { type: 'TOGGLE_PRECIPITATION' })

      expect(state.temperature).toBe(true)
      expect(state.windSpeed).toBe(true)
      expect(state.precipitation).toBe(true)
      expect(state.timeFormat).toBe(false)
      expect(state.distance).toBe(false)
    })
  })
})
