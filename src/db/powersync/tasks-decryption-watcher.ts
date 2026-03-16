import type { TriggerRemoveCallback } from '@powersync/common'
import { DiffTriggerOperation } from '@powersync/common'
import { getPowerSyncInstance } from './database'
import { decodeIfBase64 } from '@/lib/base64'

export const setupTasksDecryptionWatcher = async (): Promise<TriggerRemoveCallback | null> => {
  const powerSync = getPowerSyncInstance()
  if (!powerSync) {
    return null
  }

  return powerSync.triggers.trackTableDiff({
    source: 'tasks',
    columns: ['item'],
    when: {
      [DiffTriggerOperation.INSERT]: 'TRUE',
      [DiffTriggerOperation.UPDATE]: 'TRUE',
      [DiffTriggerOperation.DELETE]: 'TRUE',
    },
    hooks: {
      beforeCreate: async (ctx) => {
        const existingTasks = await ctx.getAll<{ id: string; item: string | null }>('SELECT id, item FROM tasks')
        for (const task of existingTasks) {
          const decodedItem = task.item ? decodeIfBase64(task.item) : task.item
          await ctx.execute('INSERT OR REPLACE INTO tasks_decrypted (id, item) VALUES (?, ?)', [task.id, decodedItem])
        }
      },
    },
    onChange: async (context) => {
      type DiffRow = { id: string; item: string | null; __operation: string }
      const diffs = await context.withExtractedDiff<DiffRow>('SELECT * FROM DIFF')

      for (const diff of diffs) {
        if (diff.__operation === DiffTriggerOperation.DELETE) {
          await context.execute('DELETE FROM tasks_decrypted WHERE id = ?', [diff.id])
        } else {
          const decodedItem = diff.item ? decodeIfBase64(diff.item) : diff.item
          await context.execute('INSERT OR REPLACE INTO tasks_decrypted (id, item) VALUES (?, ?)', [
            diff.id,
            decodedItem,
          ])
        }
      }
    },
  })
}
