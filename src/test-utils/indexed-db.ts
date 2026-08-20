/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * happy-dom implements no IndexedDB, so any code path reaching
 * `@/crypto/key-storage` throws `ReferenceError: indexedDB is not defined`
 * (the module reads the bare global, not a property).
 *
 * That absence is load-bearing for some tests — the boot pipeline's storage
 * pre-flight is *supposed* to report STORAGE_UNAVAILABLE without it — so the
 * global preload deliberately does not polyfill it. Tests that need the API
 * present opt in with these helpers instead.
 *
 * Restoring matters: the global is worker-wide and leaks into later test files.
 * A stub left behind makes a "no IndexedDB" test pass for the wrong reason, and
 * `defineProperty(..., { value: undefined })` is NOT a valid restore — it leaves
 * the property defined-but-undefined, which turns a would-be `ReferenceError`
 * into a `TypeError` and quietly changes what the code under test does.
 */

/** Present so `restoreIndexedDb` can tell "was absent" from "was something". */
const absent = Symbol('absent')

/** Distinguishes "nothing snapshotted yet" from a snapshotted absence. */
const unstubbed = Symbol('unstubbed')

let previous: IDBFactory | typeof absent | typeof unstubbed = unstubbed

/**
 * Installs a minimal `indexedDB` whose `open()` always succeeds on a microtask.
 * That covers availability probes (`isIndexedDbAvailable`) and nothing more —
 * the returned database has no `transaction`, so key-storage reads and writes
 * fail loudly rather than hanging on an event this fake never fires. Extend it
 * here, with a test, if a case genuinely needs a backing store.
 *
 * Nested calls keep the first snapshot, so a stub can never restore over a stub.
 */
export const stubIndexedDb = (): void => {
  if (previous === unstubbed) {
    previous = 'indexedDB' in globalThis ? globalThis.indexedDB : absent
  }

  const factory = {
    open: () => {
      const request = {
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        result: { close: () => {} },
      }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
    deleteDatabase: () => ({}),
  } as unknown as IDBFactory

  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true })
}

/** Puts the global back exactly as it was — deleting it when it never existed. */
export const restoreIndexedDb = (): void => {
  const restored = previous
  if (restored === unstubbed) {
    return
  }
  previous = unstubbed
  if (restored === absent) {
    Reflect.deleteProperty(globalThis, 'indexedDB')
    return
  }
  Object.defineProperty(globalThis, 'indexedDB', { value: restored, configurable: true, writable: true })
}
