import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { StorageError } from './errors'
import { LocalStorageAdapter } from './key-storage'

describe('LocalStorageAdapter', () => {
  let storage: LocalStorageAdapter

  beforeEach(() => {
    localStorage.clear()
    storage = new LocalStorageAdapter()
  })

  afterEach(() => {
    localStorage.clear()
  })

  test('get returns null for missing key', () => {
    expect(storage.get('thunderbolt_missing')).toBeNull()
  })

  test('set and get round-trip', () => {
    storage.set('thunderbolt_test', 'value123')
    expect(storage.get('thunderbolt_test')).toBe('value123')
  })

  test('delete removes a key', () => {
    storage.set('thunderbolt_test', 'value')
    storage.delete('thunderbolt_test')
    expect(storage.get('thunderbolt_test')).toBeNull()
  })

  test('exists returns true for existing key', () => {
    storage.set('thunderbolt_test', 'value')
    expect(storage.exists('thunderbolt_test')).toBe(true)
  })

  test('exists returns false for missing key', () => {
    expect(storage.exists('thunderbolt_missing')).toBe(false)
  })

  test('clear removes only thunderbolt_* keys', () => {
    storage.set('thunderbolt_enc_key', 'secret')
    storage.set('thunderbolt_enc_salt', 'salt')
    localStorage.setItem('other_app_key', 'keep_me')

    storage.clear()

    expect(storage.get('thunderbolt_enc_key')).toBeNull()
    expect(storage.get('thunderbolt_enc_salt')).toBeNull()
    expect(localStorage.getItem('other_app_key')).toBe('keep_me')
  })

  test('set throws StorageError on QuotaExceededError', () => {
    const mockStorage = {
      data: new Map<string, string>(),
      getItem(key: string) {
        return this.data.get(key) ?? null
      },
      setItem() {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      },
      removeItem(key: string) {
        this.data.delete(key)
      },
      key(index: number) {
        return [...this.data.keys()][index] ?? null
      },
      get length() {
        return this.data.size
      },
    }

    const adapter = new LocalStorageAdapter(mockStorage)
    expect(() => adapter.set('thunderbolt_test', 'value')).toThrow(StorageError)
  })
})
