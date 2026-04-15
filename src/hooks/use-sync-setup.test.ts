import { describe, expect, it } from 'bun:test'
import { reducer, initialState } from './use-sync-setup'

describe('sync setup reducer', () => {
  it('starts at intro step with no loading', () => {
    expect(initialState.step).toBe('intro')
    expect(initialState.isLoading).toBe(false)
    expect(initialState.error).toBeNull()
  })

  it('CONTINUE_INTRO transitions to detecting with loading', () => {
    const state = reducer(initialState, { type: 'CONTINUE_INTRO' })
    expect(state.step).toBe('detecting')
    expect(state.isLoading).toBe(true)
    expect(state.error).toBeNull()
  })

  it('CONTINUE_INTRO clears previous error', () => {
    const withError = { ...initialState, error: 'previous error' }
    const state = reducer(withError, { type: 'CONTINUE_INTRO' })
    expect(state.error).toBeNull()
  })

  it('DETECTED_FIRST_DEVICE transitions to first-device-setup', () => {
    const detecting = reducer(initialState, { type: 'CONTINUE_INTRO' })
    const state = reducer(detecting, { type: 'DETECTED_FIRST_DEVICE' })
    expect(state.step).toBe('first-device-setup')
    expect(state.isLoading).toBe(false)
  })

  it('DETECTED_ADDITIONAL_DEVICE transitions to approval-waiting', () => {
    const detecting = reducer(initialState, { type: 'CONTINUE_INTRO' })
    const state = reducer(detecting, { type: 'DETECTED_ADDITIONAL_DEVICE' })
    expect(state.step).toBe('approval-waiting')
    expect(state.isLoading).toBe(false)
  })

  it('SET_RECOVERY_KEY stores key and transitions to recovery-key-display', () => {
    const state = reducer(initialState, { type: 'SET_RECOVERY_KEY', payload: 'word1 word2 word3' })
    expect(state.step).toBe('recovery-key-display')
    expect(state.recoveryKey).toBe('word1 word2 word3')
    expect(state.isLoading).toBe(false)
  })

  it('GO_TO_RECOVERY_KEY_ENTRY transitions and clears input/error', () => {
    const withInput = { ...initialState, recoveryKeyInput: 'old input', recoveryKeyError: 'old error' }
    const state = reducer(withInput, { type: 'GO_TO_RECOVERY_KEY_ENTRY' })
    expect(state.step).toBe('recovery-key-entry')
    expect(state.recoveryKeyInput).toBe('')
    expect(state.recoveryKeyError).toBeNull()
  })

  it('SET_RECOVERY_KEY_INPUT updates input and clears error', () => {
    const withError = { ...initialState, recoveryKeyError: 'some error' }
    const state = reducer(withError, { type: 'SET_RECOVERY_KEY_INPUT', payload: 'new input' })
    expect(state.recoveryKeyInput).toBe('new input')
    expect(state.recoveryKeyError).toBeNull()
  })

  it('SET_RECOVERY_KEY_ERROR stores error and stops loading', () => {
    const loading = { ...initialState, isLoading: true }
    const state = reducer(loading, { type: 'SET_RECOVERY_KEY_ERROR', payload: 'bad phrase' })
    expect(state.recoveryKeyError).toBe('bad phrase')
    expect(state.isLoading).toBe(false)
  })

  it('SET_APPROVAL_ERROR stores error and stops loading', () => {
    const loading = { ...initialState, isLoading: true }
    const state = reducer(loading, { type: 'SET_APPROVAL_ERROR', payload: 'not approved' })
    expect(state.approvalError).toBe('not approved')
    expect(state.isLoading).toBe(false)
  })

  it('START_LOADING sets loading and clears error', () => {
    const withError = { ...initialState, error: 'old' }
    const state = reducer(withError, { type: 'START_LOADING' })
    expect(state.isLoading).toBe(true)
    expect(state.error).toBeNull()
  })

  it('STOP_LOADING clears loading', () => {
    const loading = { ...initialState, isLoading: true }
    const state = reducer(loading, { type: 'STOP_LOADING' })
    expect(state.isLoading).toBe(false)
  })

  it('SET_ERROR stores error and stops loading', () => {
    const loading = { ...initialState, isLoading: true }
    const state = reducer(loading, { type: 'SET_ERROR', payload: 'Failed' })
    expect(state.error).toBe('Failed')
    expect(state.isLoading).toBe(false)
  })

  it('CLEAR_ERROR clears error', () => {
    const withError = { ...initialState, error: 'some error' }
    const state = reducer(withError, { type: 'CLEAR_ERROR' })
    expect(state.error).toBeNull()
  })

  it('SETUP_COMPLETE transitions to setup-complete and stops loading', () => {
    const loading = { ...initialState, isLoading: true }
    const state = reducer(loading, { type: 'SETUP_COMPLETE' })
    expect(state.step).toBe('setup-complete')
    expect(state.isLoading).toBe(false)
  })

  it('GO_BACK returns to intro step', () => {
    const advanced = { ...initialState, step: 'approval-waiting' as const, recoveryKeyInput: 'stuff' }
    const state = reducer(advanced, { type: 'GO_BACK' })
    expect(state.step).toBe('intro')
  })

  it('RESET returns to initial state', () => {
    const modified = {
      ...initialState,
      step: 'recovery-key-display' as const,
      recoveryKey: 'some key',
      isLoading: true,
      error: 'an error',
    }
    const state = reducer(modified, { type: 'RESET' })
    expect(state).toEqual(initialState)
  })

  it('returns current state for unknown action type', () => {
    const state = reducer(initialState, { type: 'UNKNOWN' } as never)
    expect(state).toEqual(initialState)
  })
})
