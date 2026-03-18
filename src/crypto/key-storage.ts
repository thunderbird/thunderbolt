import { StorageError } from './errors'

export type KeyStorage = {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  exists(key: string): boolean
  /** Removes all thunderbolt_* keys — used on sign-out */
  clear(): void
}

type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
  readonly length: number
}

export class LocalStorageAdapter implements KeyStorage {
  private storage: StorageLike

  constructor(storage?: StorageLike) {
    this.storage = storage ?? localStorage
  }

  get(key: string): string | null {
    return this.storage.getItem(key)
  }

  set(key: string, value: string): void {
    try {
      this.storage.setItem(key, value)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        throw new StorageError('localStorage quota exceeded')
      }
      throw e
    }
  }

  delete(key: string): void {
    this.storage.removeItem(key)
  }

  exists(key: string): boolean {
    return this.storage.getItem(key) !== null
  }

  clear(): void {
    const keysToRemove: string[] = []
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)
      if (key?.startsWith('thunderbolt_')) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach((key) => this.storage.removeItem(key))
  }
}

export const keyStorage: KeyStorage = new LocalStorageAdapter()
