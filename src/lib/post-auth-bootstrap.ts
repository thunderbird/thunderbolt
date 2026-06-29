/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ensurePersonalWorkspace } from '@/dal'
import { getCurrentDatabase } from '@/db/database'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { runDataMigrations } from '@/lib/data-migrations'
import { createHandleError } from '@/lib/error-utils'
import { trackError, trackEvent } from '@/lib/posthog'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { findLegacyDbFilename, runLocalDbMigration } from '@/migrations/pre-workspaces-attach'
import { getActiveTrustDomain } from '@/stores/trust-domain-registry'
import { computePersonalWorkspaceId } from '@shared/workspaces'

/**
 * Trigger context for the post-auth bootstrap. Either the user's id and
 * isAnonymous flag (server modes), or the standalone marker.
 */
export type BootstrapContext =
  | { kind: 'server'; userId: string; isAnonymous: boolean }
  | { kind: 'standalone'; userId: string }

/**
 * Module-level inflight promise. Concurrent callers — e.g. an OTP submit handler
 * awaiting the bootstrap while the `SessionToWorkspaceBootstrap` observer also
 * fires on the same session change — share a single run instead of double-syncing,
 * double-reconciling, and racing for the active workspace store.
 */
let inflight: Promise<void> | null = null

/**
 * Post-auth pipeline. Once authentication (real or anonymous) is established,
 * this resolves-or-creates the personal workspace locally, populates the
 * active workspace store, reconciles default rows, and runs idempotent data
 * migrations.
 *
 * Idempotent: safe to call multiple times. Subsequent calls during an in-flight
 * run return the same promise; calls after a completed run resolve the existing
 * local workspace (cheap) and re-reconcile defaults (no-op via defaultHash).
 *
 * Branches:
 *  - standalone (post-v1) → throws `NOT_IMPLEMENTED` for v1. The standalone
 *    branch lands in a separate ticket; v1 production never reaches it.
 *  - real or anonymous user → FE-creates the personal workspace locally with a
 *    deterministic id (shared/workspaces.ts) so concurrent multi-device first
 *    sign-ins upsert the same row instead of racing.
 *
 * The caller is expected to ensure the database is initialized and the trust
 * domain is set — both are guaranteed by `useAppInitialization` having completed.
 */
export const runPostAuthBootstrap = async (ctx: BootstrapContext): Promise<void> => {
  if (inflight) {
    return inflight
  }
  inflight = runBootstrapInternal(ctx).finally(() => {
    inflight = null
  })
  return inflight
}

const runBootstrapInternal = async (ctx: BootstrapContext): Promise<void> => {
  const database = getCurrentDatabase()
  if (!database?.isInitialized) {
    throw new Error('Post-auth bootstrap called before database initialization')
  }
  const db: AnyDrizzleDatabase = database.db

  const trustDomain = getActiveTrustDomain()
  if (!trustDomain) {
    throw new Error('Post-auth bootstrap called with no active trust domain')
  }

  if (ctx.kind === 'standalone') {
    throw new Error('NOT_IMPLEMENTED: standalone post-auth bootstrap (post-v1)')
  }

  // Pre-Workspaces v1 data migration — step 3. ATTACH the legacy
  // `thunderbolt-sync.db` onto the new `server-<id>.db` and copy rows into the
  // workspace_id-stamped schema.
  //
  // ORDER IS LOAD-BEARING: this runs BEFORE `ensurePersonalWorkspace` because
  // `<WorkspaceGate>` lives-queries the personal workspace row's existence as
  // the bootstrap-complete signal. If we inserted the workspace row first,
  // routes would render against an empty DB before the migration backfilled
  // it — chat URLs would `navigate('/not-found')` from `use-hydrate-chat-store`
  // and `OnboardingDialog` would fire on the default `user_has_completed_onboarding=false`.
  // The FE schema has no FK from data tables → workspaces, so stamping rows
  // with a workspace_id whose row doesn't exist yet is fine; `ensurePersonalWorkspace`
  // below inserts it before any consumer looks for the workspace itself.
  //
  // BE-side state is already correct for the migration cohort: 0020 created
  // the workspace + admin membership for every existing user at deploy time,
  // so PowerSync's FIFO upload of the data rows (queued before the workspace
  // row) passes `isWorkspaceMember` regardless of upload order.
  //
  // Server-only — the standalone branch threw above.
  const personalWorkspaceId = computePersonalWorkspaceId(ctx.userId)

  if (trustDomain.kind === 'server') {
    try {
      const legacyDb = await findLegacyDbFilename()
      const dbMigration = await runLocalDbMigration({
        newDb: db,
        serverId: trustDomain.serverId,
        personalWorkspaceId,
        legacyDb,
      })
      if (dbMigration.ranMigration) {
        trackEvent('migration_db_completed', {
          duration_ms: Math.round(dbMigration.durationMs),
          rows_inserted: dbMigration.rowsInsertedByTable,
          model_api_keys_copied: dbMigration.modelApiKeysCopied,
          legacy_ps_crud_copied: dbMigration.legacyPsCrudCopied,
        })
      }
    } catch (error) {
      // Failure here leaves the completion flag unset → next boot retries.
      // Don't abort bootstrap: the user can still operate against the new
      // (empty) DB while we surface telemetry, and a retry has a good shot.
      console.error('Failed to run pre-Workspaces local DB migration:', error)
      trackError(
        createHandleError('PRE_WORKSPACES_LOCAL_DB_MIGRATION_FAILED', 'Failed to migrate local SQLite', error),
        { migration_step: 'local_db' },
      )
    }
  }

  // Personal workspace is FE-created with a deterministic id (shared/workspaces.ts).
  // Multi-device safety comes from the deterministic id: every device computes
  // the same id, so concurrent uploads are upserts rather than racing for a
  // partial-unique-index slot. Anonymous users follow the same path (post-v1) —
  // anon never syncs, so the local workspace is the only one.
  //
  // No store update: the workspace row's existence in the local DB IS the
  // readiness signal — `<WorkspaceGate>` lives-queries it, DAL inserts derive
  // the active workspace id from URL or personal-lookup.
  const workspace = await ensurePersonalWorkspace(db, ctx.userId)

  await reconcileDefaults(db, workspace.id)

  // Data migrations sit AFTER reconcileDefaults so any newly-seeded defaults
  // (e.g. the daily-brief skill) are present when a migration checks for slug
  // collisions. The runner swallows per-migration failures so it never throws.
  await runDataMigrations(db, workspace.id)
}

/**
 * Resets the inflight bootstrap so the next sign-in / sign-up triggers a fresh
 * run. The workspace-readiness signal (presence of the personal workspace row)
 * is reset by the DB wipe that sign-out / account-deletion / device-revocation
 * paths already perform — no separate state to clear here.
 */
export const resetPostAuthBootstrap = (): void => {
  inflight = null
}
