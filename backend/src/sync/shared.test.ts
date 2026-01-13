import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  type SerializedChange,
  checkMigrationVersionRequirement,
  compareMigrationVersions,
  ensureMockUserExists,
  fetchChangesSince,
  getLatestServerVersion,
  getMaxServerVersion,
  getRequiredMigrationVersion,
  insertChanges,
  MOCK_USER,
  serializeChanges,
  updateMigrationVersionIfNewer,
  upsertSyncDevice,
} from './shared'

describe('Sync Shared Utilities', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('compareMigrationVersions', () => {
    it('returns 0 when both are null', () => {
      expect(compareMigrationVersions(null, null)).toBe(0)
    })

    it('returns -1 when first is null', () => {
      expect(compareMigrationVersions(null, '0001_migration')).toBe(-1)
    })

    it('returns 1 when second is null', () => {
      expect(compareMigrationVersions('0001_migration', null)).toBe(1)
    })

    it('compares version numbers correctly', () => {
      expect(compareMigrationVersions('0001_first', '0002_second')).toBeLessThan(0)
      expect(compareMigrationVersions('0002_second', '0001_first')).toBeGreaterThan(0)
      expect(compareMigrationVersions('0001_first', '0001_other')).toBe(0)
    })

    it('handles multi-digit version numbers', () => {
      expect(compareMigrationVersions('0099_old', '0100_new')).toBeLessThan(0)
      expect(compareMigrationVersions('0100_new', '0099_old')).toBeGreaterThan(0)
    })

    it('handles versions without underscore', () => {
      expect(compareMigrationVersions('0001', '0002')).toBeLessThan(0)
    })
  })

  describe('ensureMockUserExists', () => {
    it('creates mock user when not exists', async () => {
      await ensureMockUserExists(db)

      const requiredVersion = await getRequiredMigrationVersion(db, MOCK_USER.id)
      // If we can fetch the required version, the user exists
      expect(requiredVersion).toBeNull()
    })

    it('does not duplicate mock user on second call', async () => {
      await ensureMockUserExists(db)
      await ensureMockUserExists(db)

      // No error means it worked
      const requiredVersion = await getRequiredMigrationVersion(db, MOCK_USER.id)
      expect(requiredVersion).toBeNull()
    })
  })

  describe('getRequiredMigrationVersion', () => {
    it('returns null for new user', async () => {
      await ensureMockUserExists(db)

      const version = await getRequiredMigrationVersion(db, MOCK_USER.id)
      expect(version).toBeNull()
    })

    it('returns set version after update', async () => {
      await ensureMockUserExists(db)
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0002_test')

      const version = await getRequiredMigrationVersion(db, MOCK_USER.id)
      expect(version).toBe('0002_test')
    })
  })

  describe('checkMigrationVersionRequirement', () => {
    beforeEach(async () => {
      await ensureMockUserExists(db)
    })

    it('returns needsUpgrade false when no required version', async () => {
      const result = await checkMigrationVersionRequirement(db, MOCK_USER.id, undefined)
      expect(result.needsUpgrade).toBe(false)
      expect(result.requiredVersion).toBeNull()
    })

    it('returns needsUpgrade false when client version meets requirement', async () => {
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0002_test')

      const result = await checkMigrationVersionRequirement(db, MOCK_USER.id, '0003_newer')
      expect(result.needsUpgrade).toBe(false)
    })

    it('returns needsUpgrade true when client version is older', async () => {
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0003_newer')

      const result = await checkMigrationVersionRequirement(db, MOCK_USER.id, '0001_old')
      expect(result.needsUpgrade).toBe(true)
      expect(result.requiredVersion).toBe('0003_newer')
    })
  })

  describe('updateMigrationVersionIfNewer', () => {
    beforeEach(async () => {
      await ensureMockUserExists(db)
    })

    it('updates version when new version is provided', async () => {
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0001_first')

      const version = await getRequiredMigrationVersion(db, MOCK_USER.id)
      expect(version).toBe('0001_first')
    })

    it('updates version when new version is newer', async () => {
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0001_first')
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0002_second')

      const version = await getRequiredMigrationVersion(db, MOCK_USER.id)
      expect(version).toBe('0002_second')
    })

    it('does not update when new version is older (atomic compare-and-set)', async () => {
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0002_second')
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0001_first')

      const version = await getRequiredMigrationVersion(db, MOCK_USER.id)
      expect(version).toBe('0002_second')
    })

    it('does nothing when new version is undefined', async () => {
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, '0002_second')
      await updateMigrationVersionIfNewer(db, MOCK_USER.id, undefined)

      const version = await getRequiredMigrationVersion(db, MOCK_USER.id)
      expect(version).toBe('0002_second')
    })
  })

  describe('upsertSyncDevice', () => {
    beforeEach(async () => {
      await ensureMockUserExists(db)
    })

    it('creates new device record', async () => {
      await upsertSyncDevice(db, MOCK_USER.id, 'site-123', '0001_first')
      // No error means it worked
    })

    it('updates existing device record', async () => {
      await upsertSyncDevice(db, MOCK_USER.id, 'site-123', '0001_first')
      await upsertSyncDevice(db, MOCK_USER.id, 'site-123', '0002_second')
      // No error means it worked
    })
  })

  describe('getLatestServerVersion', () => {
    beforeEach(async () => {
      await ensureMockUserExists(db)
    })

    it('returns 0 when no changes exist', async () => {
      const version = await getLatestServerVersion(db, MOCK_USER.id)
      expect(version).toBe(0)
    })

    it('returns latest version after inserting changes', async () => {
      const changes: SerializedChange[] = [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
      ]

      const inserted = await insertChanges(db, MOCK_USER.id, 'site-123', changes)
      const version = await getLatestServerVersion(db, MOCK_USER.id)

      expect(version).toBe(inserted[0].id)
    })
  })

  describe('insertChanges', () => {
    beforeEach(async () => {
      await ensureMockUserExists(db)
    })

    it('inserts single change', async () => {
      const changes: SerializedChange[] = [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
      ]

      const result = await insertChanges(db, MOCK_USER.id, 'site-123', changes)

      expect(result).toHaveLength(1)
      expect(result[0].tableName).toBe('test_table')
      expect(result[0].pk).toBe('pk1')
    })

    it('inserts multiple changes', async () => {
      const changes: SerializedChange[] = [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
        {
          table: 'test_table',
          pk: 'pk2',
          cid: 'col2',
          val: 'value2',
          col_version: '2',
          db_version: '2',
          site_id: 'site-123',
          cl: 1,
          seq: 1,
        },
      ]

      const result = await insertChanges(db, MOCK_USER.id, 'site-123', changes)

      expect(result).toHaveLength(2)
    })

    it('handles null values', async () => {
      const changes: SerializedChange[] = [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: null,
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
      ]

      const result = await insertChanges(db, MOCK_USER.id, 'site-123', changes)

      expect(result).toHaveLength(1)
      expect(result[0].val).toBeNull()
    })
  })

  describe('fetchChangesSince', () => {
    beforeEach(async () => {
      await ensureMockUserExists(db)
    })

    it('returns empty array when no changes', async () => {
      const changes = await fetchChangesSince(db, MOCK_USER.id, 0)
      expect(changes).toHaveLength(0)
    })

    it('returns changes after given version', async () => {
      const inserted = await insertChanges(db, MOCK_USER.id, 'site-123', [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: '1',
          db_version: '1',
          site_id: 'site-123',
          cl: 1,
          seq: 0,
        },
        {
          table: 'test_table',
          pk: 'pk2',
          cid: 'col2',
          val: 'value2',
          col_version: '2',
          db_version: '2',
          site_id: 'site-123',
          cl: 1,
          seq: 1,
        },
      ])

      const changes = await fetchChangesSince(db, MOCK_USER.id, inserted[0].id)

      expect(changes).toHaveLength(1)
      expect(changes[0].pk).toBe('pk2')
    })

    it('respects limit parameter', async () => {
      await insertChanges(
        db,
        MOCK_USER.id,
        'site-123',
        Array.from({ length: 10 }, (_, i) => ({
          table: 'test_table',
          pk: `pk${i}`,
          cid: 'col1',
          val: `value${i}`,
          col_version: String(i + 1),
          db_version: String(i + 1),
          site_id: 'site-123',
          cl: 1,
          seq: i,
        })),
      )

      const changes = await fetchChangesSince(db, MOCK_USER.id, 0, 5)

      expect(changes).toHaveLength(5)
    })
  })

  describe('serializeChanges', () => {
    it('serializes raw changes to network format', () => {
      const rawChanges = [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: 'value1',
          col_version: BigInt(1),
          db_version: BigInt(1),
          site_id: 'site-123',
          cl: 1,
          seq: 0,
          id: 1,
        },
      ]

      const serialized = serializeChanges(rawChanges)

      expect(serialized).toHaveLength(1)
      expect(serialized[0].col_version).toBe('1')
      expect(serialized[0].db_version).toBe('1')
      expect(typeof serialized[0].col_version).toBe('string')
    })

    it('handles null values', () => {
      const rawChanges = [
        {
          table: 'test_table',
          pk: 'pk1',
          cid: 'col1',
          val: null,
          col_version: BigInt(1),
          db_version: BigInt(1),
          site_id: 'site-123',
          cl: 1,
          seq: 0,
          id: 1,
        },
      ]

      const serialized = serializeChanges(rawChanges)

      expect(serialized[0].val).toBeNull()
    })
  })

  describe('getMaxServerVersion', () => {
    it('returns fallback when array is empty', () => {
      expect(getMaxServerVersion([], 42)).toBe(42)
    })

    it('returns max id from array', () => {
      const changes = [{ id: 1 }, { id: 5 }, { id: 3 }]
      expect(getMaxServerVersion(changes, 0)).toBe(5)
    })

    it('works with single item', () => {
      const changes = [{ id: 10 }]
      expect(getMaxServerVersion(changes, 0)).toBe(10)
    })
  })
})
