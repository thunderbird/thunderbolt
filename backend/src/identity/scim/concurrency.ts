/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { db as DbType } from '@/db/client'
import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'

/*
 * On Postgres, concurrent writes to one SCIM user or group fail the plugin's optimistic revision
 * check with a 409 "changed concurrently; retry the request". IdPs send writes in parallel, so
 * this module serializes them within the process and retries what still conflicts (writes on
 * another worker, or on another resource that touches the same user).
 */

/** Runs callbacks one at a time per key; different keys run in parallel. */
export const createKeyedLock = () => {
  const tails = new Map<string, Promise<unknown>>()
  return async <T>(key: string, callback: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.then(callback, callback)
    const tail = run.catch(() => undefined)
    tails.set(key, tail)
    try {
      return await run
    } finally {
      if (tails.get(key) === tail) {
        tails.delete(key)
      }
    }
  }
}

export type KeyedLock = ReturnType<typeof createKeyedLock>

/** Whether a database runs on Postgres, which several backend processes can share, rather than PGlite. */
export const isPostgres = (database: typeof DbType) => !(database.$client instanceof PGlite)

/** Lock transactions open at once per process, so they can't take the pool from the writes they guard. */
const maxSharedLockHolders = 3

/** Runs at most `limit` tasks at once; the rest wait in order. */
const createSemaphore = (limit: number) => {
  let active = 0
  const waiting: (() => void)[] = []
  const acquire = () => {
    if (active < limit) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => waiting.push(resolve))
  }
  const release = () => {
    const next = waiting.shift()
    if (next) {
      next()
      return
    }
    active--
  }
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire()
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/**
 * A lock every backend instance shares, on Postgres: a transaction-scoped advisory lock on the key,
 * held while `callback` runs. The lock's transaction does nothing else; the callback writes through
 * other pooled connections, and the cap on holders leaves the pool to them.
 */
export const createSharedLock = (database: typeof DbType): KeyedLock => {
  const holders = createSemaphore(maxSharedLockHolders)
  return (key, callback) =>
    holders(() =>
      database.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
        return callback()
      }),
    )
}

/** Retries after the first attempt. */
export const concurrentWriteRetries = 5

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 25 ms doubling to 400 ms, with full jitter, so racing writers spread out. */
const backoffMs = (retry: number) => Math.random() * Math.min(400, 25 * 2 ** retry)

/**
 * True for the plugin's optimistic-lock conflict: a 409 without `scimType` whose detail says the
 * resource changed concurrently. A `uniqueness` 409 is a real answer and is never retried.
 */
export const isConcurrentWriteConflict = async (response: Response) => {
  if (response.status !== 409) {
    return false
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { scimType?: unknown; detail?: unknown } | null
  return (
    body !== null &&
    body.scimType === undefined &&
    typeof body.detail === 'string' &&
    /changed concurrently/i.test(body.detail)
  )
}

/**
 * Send a SCIM write, and send it again while it loses an optimistic-lock race. Safe because the
 * plugin's transaction rolled back. `send` must build a fresh request each time.
 */
export const sendRetryingConcurrentConflicts = async (
  send: () => Promise<Response>,
  wait: (ms: number) => Promise<unknown> = sleep,
) => {
  const attempt = async (retry: number): Promise<Response> => {
    const response = await send()
    if (retry >= concurrentWriteRetries || !(await isConcurrentWriteConflict(response))) {
      return response
    }
    await wait(backoffMs(retry))
    return attempt(retry + 1)
  }
  return attempt(0)
}
