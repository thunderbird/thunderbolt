# CR-SQLite Sync Architecture

This document provides a comprehensive guide to the multi-device synchronization system built on **cr-sqlite** (Conflict-free Replicated SQLite). It covers the frontend schema design, backend relay system, conflict resolution, and migration handling.

## Table of Contents

1. [Overview](#overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Key Concepts](#key-concepts)
4. [Frontend: CR-SQLite Database](#frontend-cr-sqlite-database)
   - [Database Schema Constraints](#database-schema-constraints)
   - [CRR Tables](#crr-tables)
   - [Schema Definition](#schema-definition)
5. [Backend: Sync Relay Server](#backend-sync-relay-server)
   - [Sync Tables Schema](#sync-tables-schema)
   - [API Endpoints](#api-endpoints)
6. [Sync Flow](#sync-flow)
   - [Push Flow](#push-flow)
   - [Pull Flow](#pull-flow)
   - [Full Sync Cycle](#full-sync-cycle)
7. [Conflict Resolution](#conflict-resolution)
   - [How CRDTs Work](#how-crdts-work)
   - [Last-Writer-Wins (LWW)](#last-writer-wins-lww)
   - [Column-Level Versioning](#column-level-versioning)
8. [Migration Handling](#migration-handling)
   - [Version Compatibility](#version-compatibility)
   - [Migration Version Tracking](#migration-version-tracking)
   - [Outdated Client Handling](#outdated-client-handling)
   - [CR-SQLite Migration Workaround](#cr-sqlite-migration-workaround)
9. [Initialization Flow](#initialization-flow)
10. [Network & Offline Handling](#network--offline-handling)
11. [Key Files Reference](#key-files-reference)
12. [Common Issues & Debugging](#common-issues--debugging)

---

## Overview

The sync system enables users to access their data seamlessly across multiple devices. It uses **cr-sqlite**, a SQLite extension that adds CRDT (Conflict-free Replicated Data Type) capabilities to SQLite databases. This allows:

- **Offline-first operation**: Users can work offline, and changes sync when online
- **Automatic conflict resolution**: Concurrent edits are merged automatically
- **Multi-device sync**: Data stays consistent across all user devices

The architecture consists of:

1. **Frontend**: CR-SQLite database running in a Web Worker
2. **Backend**: PostgreSQL relay server that stores and distributes changes between devices

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DEVICE A                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  React App                                                            │   │
│  │  ├── SyncService (manages sync lifecycle)                            │   │
│  │  ├── useSyncService() hook (React integration)                       │   │
│  │  └── DatabaseSingleton (database access)                             │   │
│  └───────────────────────────────┬──────────────────────────────────────┘   │
│                                  │                                           │
│  ┌───────────────────────────────▼──────────────────────────────────────┐   │
│  │  Web Worker (crsqlite-worker.ts)                                      │   │
│  │  ├── CR-SQLite WASM Module                                            │   │
│  │  ├── crsql_changes virtual table (CRDT change tracking)              │   │
│  │  └── {table}__crsql_clock tables (per-column version clocks)         │   │
│  └───────────────────────────────┬──────────────────────────────────────┘   │
└──────────────────────────────────│──────────────────────────────────────────┘
                                   │
                                   │ HTTP (push/pull)
                                   │
┌──────────────────────────────────▼──────────────────────────────────────────┐
│                           BACKEND SERVER                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Sync Routes (Elysia)                                                  │  │
│  │  ├── POST /sync/push - Receive changes from devices                   │  │
│  │  ├── GET /sync/pull - Send changes to devices                         │  │
│  │  └── GET /sync/version - Get current server version                   │  │
│  └───────────────────────────────┬───────────────────────────────────────┘  │
│                                  │                                           │
│  ┌───────────────────────────────▼───────────────────────────────────────┐  │
│  │  PostgreSQL                                                            │  │
│  │  ├── sync_changes (stores all CRDT change records)                    │  │
│  │  ├── sync_devices (tracks devices and their migration versions)       │  │
│  │  └── user.syncMigrationVersion (minimum required version)             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ HTTP (push/pull)
                                   │
┌──────────────────────────────────▼──────────────────────────────────────────┐
│                              DEVICE B                                        │
│                         (Same structure as Device A)                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Concepts

### Site ID

Each device has a unique **site ID** (UUID) that identifies it in the sync network. This is auto-generated by cr-sqlite when the database is first created and stored in localStorage for quick access.

### DB Version

A monotonically increasing number that increments with each local change. Used to track which changes have been synced.

### Server Version

The backend assigns sequential IDs to incoming changes. Devices track the last `serverVersion` they've seen to request only new changes.

### CRR (Conflict-free Replicated Relation)

A table registered with cr-sqlite for CRDT sync. CR-SQLite creates shadow tables (`{table}__crsql_clock`) to track per-column version clocks.

### crsql_changes

A virtual table exposed by cr-sqlite that provides access to all change records. This is the source of truth for what needs to be synced.

---

## Frontend: CR-SQLite Database

### Database Schema Constraints

When designing tables for cr-sqlite sync, you **must** follow these constraints:

```typescript
/**
 * Important constraints for cr-sqlite compatibility:
 * 1. NO unique indices besides primary keys - CRRs can't have additional unique constraints
 * 2. NO checked foreign key constraints - data can arrive out of order during sync
 * 3. All NOT NULL columns must have DEFAULT values - for forwards/backwards compatibility
 *
 * Relationships are maintained logically via column names (e.g., chatThreadId -> chat_threads.id)
 * but are NOT enforced at the database level to enable CRDT-based sync.
 */
```

**Why these constraints?**

1. **No unique constraints**: CRDT merge logic doesn't understand unique constraints. Two devices could create records that conflict on a unique column, causing sync failures.

2. **No foreign keys**: Changes can arrive out of order. A child record might arrive before its parent, causing FK constraint violations.

3. **Defaults for NOT NULL**: When a new column is added, existing records on other devices won't have that column yet. Defaults ensure the sync can apply cleanly.

### CRR Tables

The following tables are registered as CRRs for sync:

```typescript
const CRR_TABLES = [
  'settings',
  'chat_threads',
  'chat_messages',
  'tasks',
  'models',
  'mcp_servers',
  'prompts',
  'triggers',
] as const
```

### Schema Definition

Location: `src/db/tables.ts`

```typescript
// Example: chat_messages table
export const chatMessagesTable = sqliteTable('chat_messages', {
  id: text('id').primaryKey().notNull(),
  content: text('content').notNull().default(''),
  role: text('role').notNull().default('user').$type<UIMessage['role']>(),
  parts: text('parts', { mode: 'json' }).$type<UIMessage['parts']>(),
  chatThreadId: text('chat_thread_id').notNull().default(''), // Logical FK (not enforced)
  modelId: text('model_id'), // Logical FK (not enforced)
  parentId: text('parent_id'), // Self-reference FK (not enforced)
  cache: text('cache', { mode: 'json' }).$type<Record<string, WidgetCacheData>>(),
  metadata: text('metadata', { mode: 'json' }).$type<UIMessageMetadata>(),
})
```

---

## Backend: Sync Relay Server

The backend acts as a relay/hub for change propagation between devices. It does **not** interpret or validate the data - it simply stores and forwards cr-sqlite change records.

### Sync Tables Schema

Location: `backend/src/sync/schema.ts`

#### sync_changes

Stores all change records from all devices:

```typescript
export const syncChanges = pgTable(
  'sync_changes',
  {
    id: serial('id').primaryKey(), // Server-assigned ID (serverVersion)
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }), // User who owns this data
    siteId: text('site_id').notNull(), // Device that made the change
    tableName: text('table_name').notNull(), // Table name (e.g., 'chat_messages')
    pk: text('pk').notNull(), // Primary key (base64 encoded)
    cid: text('cid').notNull(), // Column ID
    val: text('val'), // Value (JSON stringified)
    colVersion: bigint('col_version', { mode: 'bigint' }).notNull(), // Column version
    dbVersion: bigint('db_version', { mode: 'bigint' }).notNull(), // DB version
    cl: integer('cl').notNull(), // Causal length
    seq: integer('seq').notNull(), // Sequence number
    siteIdRaw: text('site_id_raw').notNull(), // Site ID (base64 encoded)
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('sync_changes_user_id_idx').on(table.userId),
    index('sync_changes_user_site_idx').on(table.userId, table.siteId),
    index('sync_changes_created_at_idx').on(table.createdAt),
  ],
)
```

#### sync_devices

Tracks each device's migration version and last activity:

```typescript
export const syncDevices = pgTable(
  'sync_devices',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    siteId: text('site_id').notNull(), // Device's unique site ID
    migrationVersion: text('migration_version'), // Last migration hash
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('sync_devices_user_id_idx').on(table.userId), index('sync_devices_site_id_idx').on(table.siteId)],
)
```

#### user.syncMigrationVersion

The `user` table has a `syncMigrationVersion` field that stores the **minimum required migration version** for the user's sync network:

```typescript
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  // ... other fields
  syncMigrationVersion: text('sync_migration_version'), // Minimum version required for sync
})
```

This is updated when **any** device pushes changes with a newer migration version.

### API Endpoints

Location: `backend/src/sync/routes.ts`

#### POST /sync/push

Receives changes from a device and stores them:

```typescript
// Request body
{
  siteId: string,
  changes: SerializedChange[],
  dbVersion: string,
  migrationVersion?: string
}

// Response
{
  success: boolean,
  serverVersion: string,
  needsUpgrade?: boolean,     // True if client migration is outdated
  requiredVersion?: string    // Required migration version
}
```

**Version check logic:**

1. Compare client's `migrationVersion` with user's `syncMigrationVersion`
2. If client is outdated, return `needsUpgrade: true` without accepting changes
3. If client is newer, update `syncMigrationVersion` **before** storing changes

#### GET /sync/pull

Returns changes since a given server version:

```typescript
// Query params
{
  since: string,           // Last known server version
  siteId?: string,         // Requesting device's site ID
  migrationVersion?: string
}

// Response
{
  changes: SerializedChange[],
  serverVersion: string,
  needsUpgrade?: boolean,
  requiredVersion?: string
}
```

#### GET /sync/version

Returns the current server version for the user:

```typescript
// Response
{
  serverVersion: string
}
```

---

## Sync Flow

### Push Flow

```
Device                                  Backend
   │                                       │
   │  1. getLocalChanges()                 │
   │     (query crsql_changes              │
   │      WHERE db_version > lastSynced    │
   │      AND site_id = local_site_id)     │
   │                                       │
   │  2. POST /sync/push                   │
   │     { siteId, changes, dbVersion,     │
   │       migrationVersion }              │
   │ ─────────────────────────────────────>│
   │                                       │  3. Check migrationVersion
   │                                       │  4. Insert into sync_changes
   │                                       │  5. Update sync_devices
   │                                       │
   │     { success, serverVersion }        │
   │ <─────────────────────────────────────│
   │                                       │
   │  6. Update lastSyncedVersion          │
   │  7. Update serverVersion              │
   │                                       │
```

**Important**: The `getLocalChanges()` query filters by `site_id = crsql_site_id()` to only return **local** changes. This prevents re-pushing changes that were received from other devices.

### Pull Flow

```
Device                                  Backend
   │                                       │
   │  1. GET /sync/pull                    │
   │     ?since={serverVersion}            │
   │     &siteId={siteId}                  │
   │     &migrationVersion={version}       │
   │ ─────────────────────────────────────>│
   │                                       │  2. Check migrationVersion
   │                                       │  3. Query sync_changes
   │                                       │     WHERE id > since
   │                                       │     AND userId = user.id
   │                                       │
   │     { changes, serverVersion }        │
   │ <─────────────────────────────────────│
   │                                       │
   │  4. applyRemoteChanges(changes)       │
   │     (INSERT INTO crsql_changes)       │
   │                                       │
   │  5. Update serverVersion              │
   │                                       │
   │  6. Notify React Query to refresh     │
   │                                       │
```

### Full Sync Cycle

The `SyncService` performs a full sync cycle:

```typescript
async sync(): Promise<void> {
  // 1. Push local changes first
  await this.pushChanges()

  // 2. Then pull remote changes
  await this.pullChanges()
}
```

This ensures local changes are sent before pulling, preventing the race condition where pulling might increment the local db_version, causing unpushed local changes to be skipped.

---

## Conflict Resolution

### How CRDTs Work

CR-SQLite implements **column-level CRDTs**. Each column in a CRR has its own version clock, enabling fine-grained conflict resolution.

When two devices edit the same row:

- If they edit **different columns**, both changes are preserved
- If they edit the **same column**, the "winner" is determined by the version clock

### Last-Writer-Wins (LWW)

CR-SQLite uses **Last-Writer-Wins** semantics for same-column conflicts:

```
Device A (clock: 5) writes: title = "My Chat"
Device B (clock: 3) writes: title = "Our Chat"

Result: "My Chat" wins (higher clock)
```

The version clock is determined by:

1. **col_version**: A per-column version number
2. **db_version**: The database version when the change was made
3. **site_id**: Tie-breaker (lexicographic comparison) if versions are equal

### Column-Level Versioning

Each column change is tracked independently:

```sql
-- crsql_changes virtual table structure
SELECT "table", "pk", "cid", "val", "col_version", "db_version", "site_id", "cl", "seq"
FROM crsql_changes
WHERE db_version > ?
```

| Field       | Description                             |
| ----------- | --------------------------------------- |
| table       | Table name                              |
| pk          | Primary key (binary)                    |
| cid         | Column ID (column name)                 |
| val         | New value                               |
| col_version | Version of this column's value          |
| db_version  | Database version when change was made   |
| site_id     | UUID of the device that made the change |
| cl          | Causal length (for ordering)            |
| seq         | Sequence number within the transaction  |

---

## Migration Handling

### Version Compatibility

Migration versions follow the pattern: `{number}_{name}` (e.g., `0000_nice_mandroid`).

The numeric prefix is used for comparison:

```typescript
const compareMigrationVersions = (a: string | null, b: string | null): number => {
  const getVersionNumber = (version: string): number => {
    const match = version.match(/^(\d+)/)
    return match ? parseInt(match[1], 10) : 0
  }
  return getVersionNumber(a) - getVersionNumber(b)
}
```

### Migration Version Tracking

1. **user.syncMigrationVersion**: Stores the highest migration version seen across all devices
2. **sync_devices.migrationVersion**: Tracks each device's current migration version

### Outdated Client Handling

When a client's migration version is older than `user.syncMigrationVersion`:

1. **Push blocked**: Server returns `{ needsUpgrade: true, requiredVersion: "0001_..." }`
2. **Pull blocked**: Server returns empty changes with upgrade flag
3. **Client response**: Sets sync status to `version_mismatch` and stops syncing
4. **User action required**: User must update their app to continue syncing

```typescript
// SyncService response to version mismatch
if (response.needsUpgrade && response.requiredVersion) {
  this._requiredVersion = response.requiredVersion
  this.setStatus('version_mismatch')
  this.onVersionMismatch?.(response.requiredVersion)
  this.stop()
  throw new Error('VERSION_MISMATCH')
}
```

### CR-SQLite Migration Workaround

**Problem**: CR-SQLite's `crsql_begin_alter`/`crsql_commit_alter` functions (required for schema changes on CRR tables) reset `crsql_db_version()` and clear pending changes.

**Impact**: Local changes made before migration could be permanently lost.

**Solution**: Capture and preserve changes during app initialization:

```typescript
// Step 2.5: Capture changes BEFORE migrations
let preservedChanges: SerializedChange[] = []
if (DatabaseSingleton.instance.supportsSyncing) {
  preservedChanges = await captureLocalChanges()
}

// Step 3: Run migrations (may reset crsql_db_version)
await runDatabaseMigrations(db)

// Step 3.5: Initialize CRRs
await initializeCRRs(db)

// Step 3.6: Push preserved changes (would be lost otherwise)
await pushPreservedChanges(initialHttpClient, preservedChanges)
```

**Why we can't skip `crsql_begin_alter`/`crsql_commit_alter`:**

- Without these calls, CRR metadata becomes stale
- Queries fail with "expected X values, got Y" errors
- The shadow tables and triggers expect the old schema

---

## Initialization Flow

Location: `src/hooks/use-app-initialization.ts`

```
1. Create app directory
      │
      ▼
2. Initialize database (CRSQLiteDatabase)
      │
      ▼
2.5 Capture local changes (BEFORE migrations!)
      │
      ▼
3. Run database migrations
      │
      ▼
3.5 Initialize CRRs (crsql_as_crr for new tables)
      │
      ▼
3.6 Push preserved changes + initial sync
      │
      ▼
4. Reconcile default settings
      │
      ▼
5. Initialize HTTP client
      │
      ▼
6. Initialize tray (optional)
      │
      ▼
7. Initialize PostHog (optional)
      │
      ▼
App ready! SyncService starts via useSyncService()
```

---

## Network & Offline Handling

The `SyncService` handles network status automatically:

```typescript
// Online/offline event listeners
window.addEventListener('online', this.handleOnline)
window.addEventListener('offline', this.handleOffline)

// Status transitions
'offline' → Device goes offline, syncing paused
'syncing' → Sync in progress
'idle'    → Sync complete, waiting for next interval
'error'   → Sync failed (network error, etc.)
'version_mismatch' → Client needs upgrade
```

**Offline behavior:**

- Sync attempts are skipped
- Status set to `offline`
- Changes accumulate locally
- When back online, immediate sync triggered

---

## Key Files Reference

### Frontend

| File                                  | Purpose                                    |
| ------------------------------------- | ------------------------------------------ |
| `src/db/sync-service.ts`              | SyncService class - orchestrates push/pull |
| `src/db/crsqlite-worker.ts`           | Web Worker - runs CR-SQLite WASM           |
| `src/db/crsqlite-worker-client.ts`    | Worker client - promise-based API          |
| `src/db/crsqlite-database.ts`         | Database class with sync support           |
| `src/db/singleton.ts`                 | DatabaseSingleton - global access          |
| `src/db/tables.ts`                    | Schema definitions (Drizzle)               |
| `src/db/migrate.ts`                   | Migration runner + CRR initialization      |
| `src/hooks/use-sync-service.tsx`      | React hook for sync status/control         |
| `src/hooks/use-app-initialization.ts` | App startup + migration workaround         |

### Backend

| File                            | Purpose                              |
| ------------------------------- | ------------------------------------ |
| `backend/src/sync/routes.ts`    | Sync API endpoints                   |
| `backend/src/sync/schema.ts`    | PostgreSQL sync tables (Drizzle)     |
| `backend/src/db/auth-schema.ts` | User table with syncMigrationVersion |

---

## Common Issues & Debugging

### 1. Changes not syncing

**Check:**

- Is the device online? (`navigator.onLine`)
- What's the sync status? (`useSyncService().status`)
- Are there pending changes? Query `crsql_changes` in dev tools

```sql
-- Check pending changes in browser console
SELECT * FROM crsql_changes WHERE db_version > 0;
```

### 2. "VERSION_MISMATCH" error

**Cause**: Client's migration version is older than required.

**Solution**: User must update their app. The required version is available via:

```typescript
const { requiredVersion } = useSyncService()
```

### 3. Foreign key-like data arriving out of order

**This is expected.** Design your UI to handle missing referenced data gracefully. The related record will arrive eventually.

### 4. Lost changes after app update

**Cause**: The migration workaround may have failed.

**Check**: Console logs for:

```
[Sync] Captured X local changes before migration
[Sync] Successfully pushed X preserved changes
```

### 5. "expected X values, got Y" errors

**Cause**: CRR metadata is stale after a schema change.

**Solution**: The `initializeCRRs()` function should refresh metadata:

```typescript
await db.run(sql.raw(`SELECT crsql_begin_alter('${tableName}')`))
await db.run(sql.raw(`SELECT crsql_commit_alter('${tableName}')`))
```

### 6. Debugging sync in development

```typescript
// Force a sync
const { forceSync } = useSyncService()
await forceSync()

// Check sync service status
const service = getSyncService()
console.log('Status:', service?.getStatus())
console.log('Site ID:', await service?.getSiteId())
```

---

## Future Improvements

1. **Investigate cr-sqlite change preservation**: File a GitHub issue about `crsql_commit_alter` resetting db_version
2. **Batch change limits**: Currently limited to 1000 changes per pull - consider pagination
3. **Compression**: Large change payloads could benefit from compression
4. **Selective sync**: Allow syncing only specific tables
5. **Conflict notifications**: UI to show when conflicts were auto-resolved
