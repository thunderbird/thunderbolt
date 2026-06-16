/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { db as DbType } from '@/db/client'
import type { PowerSyncTableName } from '@shared/powersync-tables'

export type UploadOp = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: PowerSyncTableName
  id: string
  data?: Record<string, unknown>
}

export type UploadCtx = {
  userId: string
  settings: Settings
}

export type HandlerResult = { kind: 'apply' } | { kind: 'reject'; class: 'permanent' | 'transient'; code: string }

/**
 * Drizzle's transaction callback receives an opaque `tx` object; the rest of the
 * codebase casts it to `typeof db` so all the usual query builders compose. We
 * follow the same idiom — see `backend/src/api/account.ts` / `encryption.ts`.
 */
export type UploadTx = typeof DbType

export type UploadHandler = {
  /**
   * Pre-write policy check. Pure read or constant-time logic where possible —
   * anything that needs the row state (last-admin protection, etc.) should run
   * inside `apply` so it shares the same transactional snapshot as the write.
   */
  validate: (op: UploadOp, ctx: UploadCtx, tx: UploadTx) => Promise<HandlerResult>
  /**
   * Performs the write. Throw `UploadRejection` to abort the batch with a
   * permanent or transient error; any other throw is treated as transient
   * (DB-level error) by the dispatcher.
   */
  apply: (op: UploadOp, ctx: UploadCtx, tx: UploadTx) => Promise<void>
}

/**
 * Thrown by handlers to abort the upload batch with a structured rejection.
 * Distinct from generic `Error` so the dispatcher can classify the failure
 * without inspecting the message.
 */
export class UploadRejection extends Error {
  constructor(
    public readonly rejectionClass: 'permanent' | 'transient',
    public readonly code: string,
  ) {
    super(`upload ${rejectionClass}: ${code}`)
    this.name = 'UploadRejection'
  }
}

/** A permanently rejected op accumulated during batch dispatch. */
export type RejectedOp = {
  op: UploadOp
  code: string
}
