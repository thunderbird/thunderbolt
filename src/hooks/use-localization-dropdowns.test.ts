import { describe, it, expect } from 'bun:test'
import { dropdownReducer, initialState } from './use-localization-dropdowns'

// Test the reducer directly since it contains the core logic
describe('useLocalizationDropdowns', () => {
  describe('dropdownReducer', () => {
    it('should initialize with all dropdowns closed', () => {
      expect(initialState).toEqual({
        distance: false,
        temperature: false,
        dateFormat: false,
        timeFormat: false,
        currency: false,
      })
    })

    it('should toggle distance dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_DISTANCE' })
      expect(state.distance).toBe(true)
      expect(state.temperature).toBe(false)
      expect(state.dateFormat).toBe(false)
      expect(state.timeFormat).toBe(false)
      expect(state.currency).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_DISTANCE' })
      expect(newState.distance).toBe(false)
    })

    it('should toggle temperature dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_TEMPERATURE' })
      expect(state.temperature).toBe(true)
      expect(state.distance).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_TEMPERATURE' })
      expect(newState.temperature).toBe(false)
    })

    it('should toggle date format dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_DATE_FORMAT' })
      expect(state.dateFormat).toBe(true)
      expect(state.temperature).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_DATE_FORMAT' })
      expect(newState.dateFormat).toBe(false)
    })

    it('should toggle time format dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_TIME_FORMAT' })
      expect(state.timeFormat).toBe(true)
      expect(state.temperature).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_TIME_FORMAT' })
      expect(newState.timeFormat).toBe(false)
    })

    it('should toggle currency dropdown', () => {
      const state = dropdownReducer(initialState, { type: 'TOGGLE_CURRENCY' })
      expect(state.currency).toBe(true)
      expect(state.temperature).toBe(false)

      const newState = dropdownReducer(state, { type: 'TOGGLE_CURRENCY' })
      expect(newState.currency).toBe(false)
    })

    it('should set dropdown state with SET_DROPDOWN action', () => {
      const state = dropdownReducer(initialState, {
        type: 'SET_DROPDOWN',
        payload: { dropdown: 'temperature', open: true },
      })
      expect(state.temperature).toBe(true)
      expect(state.distance).toBe(false)

      const newState = dropdownReducer(state, {
        type: 'SET_DROPDOWN',
        payload: { dropdown: 'temperature', open: false },
      })
      expect(newState.temperature).toBe(false)
    })

    it('should handle SET_DROPDOWN for all dropdown types', () => {
      const dropdowns = ['distance', 'temperature', 'dateFormat', 'timeFormat', 'currency'] as const

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
      let state = dropdownReducer(initialState, { type: 'TOGGLE_DISTANCE' })
      state = dropdownReducer(state, { type: 'TOGGLE_TEMPERATURE' })

      expect(state.distance).toBe(true)
      expect(state.temperature).toBe(true)
      expect(state.dateFormat).toBe(false)
      expect(state.timeFormat).toBe(false)
      expect(state.currency).toBe(false)
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
      let state = dropdownReducer(initialState, { type: 'TOGGLE_DISTANCE' })
      state = dropdownReducer(state, { type: 'TOGGLE_TEMPERATURE' })

      state = dropdownReducer(state, { type: 'TOGGLE_DATE_FORMAT' })

      expect(state.distance).toBe(true)
      expect(state.temperature).toBe(true)
      expect(state.dateFormat).toBe(true)
      expect(state.timeFormat).toBe(false)
      expect(state.currency).toBe(false)
    })
  })
})
