import { afterEach, describe, expect, it } from 'bun:test'
import { useWelcomeStore } from './welcome-dialog'

describe('useWelcomeStore', () => {
  afterEach(() => {
    // Reset store between tests
    useWelcomeStore.setState({ pending: false })
  })

  it('starts with pending = false', () => {
    expect(useWelcomeStore.getState().pending).toBe(false)
  })

  it('trigger() sets pending to true', () => {
    useWelcomeStore.getState().trigger()
    expect(useWelcomeStore.getState().pending).toBe(true)
  })

  it('consume() returns true and resets pending', () => {
    useWelcomeStore.getState().trigger()

    const result = useWelcomeStore.getState().consume()
    expect(result).toBe(true)
    expect(useWelcomeStore.getState().pending).toBe(false)
  })

  it('consume() returns false when nothing was triggered', () => {
    const result = useWelcomeStore.getState().consume()
    expect(result).toBe(false)
  })

  it('double consume() returns false on the second call', () => {
    useWelcomeStore.getState().trigger()

    expect(useWelcomeStore.getState().consume()).toBe(true)
    expect(useWelcomeStore.getState().consume()).toBe(false)
  })
})
