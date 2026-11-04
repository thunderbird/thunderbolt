/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { cloudAgentScope } from '@shared/cloud-agent/contracts'
import { encryptScopedJson } from '@shared/cloud-agent/crypto'
import { cloudAgentProjections, cloudAgents, cloudRuns, cloudSchedules } from '../db/cloud-agent-schema'
import { createIsolatedTestDb } from '../test-utils/db'
import { createCloudScheduler } from './scheduler'
import { createServiceFixture } from './service-test-fixture'
import { CloudError } from './errors'

/** Give the scanner its own database so unrelated fixture runs cannot enter its admission queue. */
const fixture = async () => {
  const database = await createIsolatedTestDb()
  const f = await createServiceFixture({ database: database.db })
  return { ...f, close: database.close }
}

describe('cloud scheduler admission and recovery', () => {
  it('limits global work, serializes turns per conversation, and suspends on shutdown', async () => {
    const f = await fixture()
    f.settings.maxConcurrentRuns = 2
    const secondConversation = await f.service.createConversation(f.ownerId, f.agentId)
    const first = await f.service.submit(f.ownerId, f.conversation.id, await f.submission('First'))
    const followup = await f.service.submit(f.ownerId, f.conversation.id, await f.submission('Follow-up'))
    const other = await f.service.submit(f.ownerId, secondConversation.id, await f.submission('Other'))
    const admitted: string[] = []
    const stopped: string[] = []
    const pending = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
    const scheduler = createCloudScheduler(
      f.service,
      {
        run: async (id) => {
          admitted.push(id)
          const task = Promise.withResolvers<void>()
          pending.set(id, task)
          await f.service.setStatus(id, 'running')
          await task.promise
          await f.service.setStatus(id, 'completed')
        },
        stop: async (id) => {
          stopped.push(id)
          pending.get(id)?.resolve()
        },
      },
      () => {},
    )
    try {
      await scheduler.tick()
      expect(admitted).toEqual([first.id, other.id])
      expect(admitted).not.toContain(followup.id)
      pending.get(first.id)!.resolve()
      await Bun.sleep(20)
      await scheduler.tick()
      expect(admitted).toEqual([first.id, other.id, followup.id])
      scheduler.stop()
      expect(stopped).toEqual([])
      for (const task of pending.values()) {
        task.resolve()
      }
      await scheduler.drain()
    } finally {
      scheduler.stop()
      for (const task of pending.values()) {
        task.resolve()
      }
      await scheduler.drain()
      await f.close()
    }
  }, 10000)

  it('admits another conversation beyond a large backlog and stops work even at capacity', async () => {
    const f = await fixture()
    f.settings.ownerDailyBudgetUsd = 10000
    f.settings.maxConcurrentRuns = 2
    const first = await f.service.submit(f.ownerId, f.conversation.id, await f.submission('First'))
    const original = (await f.service.loadRun(first.id)).run
    await f.database.insert(cloudRuns).values(
      Array.from({ length: 501 }, (_, index) => ({
        ...original,
        id: crypto.randomUUID(),
        commandId: crypto.randomUUID(),
        createdAt: new Date(Date.now() - 1000 + index).toISOString(),
      })),
    )
    const otherConversation = await f.service.createConversation(f.ownerId, f.agentId)
    const other = await f.service.submit(f.ownerId, otherConversation.id, await f.submission('Other'))
    const stopConversation = await f.service.createConversation(f.ownerId, f.agentId)
    const stopping = await f.service.submit(f.ownerId, stopConversation.id, await f.submission('Stop'))
    await f.service.setStatus(stopping.id, 'stop-requested')
    const pending = Promise.withResolvers<void>()
    const admitted: string[] = []
    const stopped: string[] = []
    const scheduler = createCloudScheduler(
      f.service,
      {
        run: async (id) => {
          admitted.push(id)
          await pending.promise
        },
        stop: async (id) => {
          stopped.push(id)
        },
      },
      () => {},
    )
    try {
      await scheduler.tick()
      expect(admitted).toHaveLength(2)
      expect(admitted).toContain(other.id)
      expect(stopped).toEqual([stopping.id])
      expect((await f.service.loadRun(stopping.id)).run.status).toBe('stopped')
      await f.service.setStatus(other.id, 'stop-requested')
      await scheduler.tick()
      expect(stopped).toEqual([stopping.id, other.id])
    } finally {
      scheduler.stop()
      pending.resolve()
      await scheduler.drain()
      await f.close()
    }
  }, 10000)

  it('does not admit work after shutdown begins during a scan', async () => {
    const f = await fixture()
    await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    const admitted: string[] = []
    const scheduler = createCloudScheduler(
      f.service,
      {
        run: async (id) => {
          admitted.push(id)
        },
        stop: async () => {},
      },
      () => {},
    )
    try {
      const scan = scheduler.tick()
      scheduler.stop()
      await scheduler.drain()
      await scan
      expect(admitted).toEqual([])
    } finally {
      scheduler.stop()
      await scheduler.drain()
      await f.close()
    }
  }, 10000)

  it('persists schedule failures, waits before retrying, and retains the failed occurrence', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    const clock = { value: new Date(), fail: true, attempts: 0 }
    const config = await encryptScopedJson(
      { name: 'Retry', prompt: 'Check', timezone: 'UTC', cadence: { type: 'interval', minutes: 30 } },
      f.key,
      {
        ownerId: f.ownerId,
        scopeId: cloudAgentScope(f.agentId),
        keyEpoch: 1,
        recordId: id,
        purpose: 'schedule',
      },
    )
    await f.service.saveSchedule(f.ownerId, {
      id,
      agentId: f.agentId,
      expectedVersion: 0,
      enabled: true,
      keyEpoch: 1,
      config,
    })
    const due = new Date(clock.value.getTime() - 60_000).toISOString()
    await f.database.update(cloudSchedules).set({ nextRunAt: due }).where(eq(cloudSchedules.id, id))
    const errors: string[] = []
    const scheduler = createCloudScheduler(
      {
        ...f.service,
        submit: async (...args) => {
          clock.attempts++
          if (clock.fail) {
            throw new CloudError(429, 'cloud_daily_budget_exceeded')
          }
          return f.service.submit(...args)
        },
      },
      {
        run: async (runId) => {
          await f.service.setStatus(runId, 'completed')
        },
        stop: async () => {},
      },
      (code) => {
        errors.push(code)
      },
      () => clock.value,
    )
    try {
      await scheduler.tick()
      const [failed] = (await f.service.schedules(f.ownerId, f.agentId)).schedules
      expect(failed!.enabled).toBe(true)
      expect(failed!.errorCode).toBe('cloud_daily_budget_exceeded')
      expect(Date.parse(failed!.nextRunAt!)).toBe(Date.parse(due))
      expect(Date.parse(failed!.retryAt!)).toBe(clock.value.getTime() + 5 * 60_000)
      clock.fail = false
      await scheduler.tick()
      expect(clock.attempts).toBe(1)
      clock.value = new Date(clock.value.getTime() + 5 * 60_000)
      await scheduler.tick()
      await scheduler.drain()
      const [recovered] = (await f.service.schedules(f.ownerId, f.agentId)).schedules
      expect(clock.attempts).toBe(2)
      expect(errors).toEqual(['cloud_daily_budget_exceeded'])
      expect(recovered!.errorCode).toBeNull()
      expect(recovered!.retryAt).toBeNull()
      expect(Date.parse(recovered!.lastRunAt!)).toBe(Date.parse(due))
      expect(await f.database.select().from(cloudRuns)).toHaveLength(1)
    } finally {
      scheduler.stop()
      await scheduler.drain()
      await f.close()
    }
  }, 10000)

  it('leaves infrastructure failures available for a later recovery attempt', async () => {
    const f = await fixture()
    const run = await f.service.submit(f.ownerId, f.conversation.id, await f.submission())
    const attempts: string[] = []
    const scheduler = createCloudScheduler(
      f.service,
      {
        run: async (id) => {
          attempts.push(id)
          throw new Error('Temporary storage outage')
        },
        stop: async () => {},
      },
      () => {},
    )
    try {
      await scheduler.tick()
      await scheduler.drain()
      expect((await f.service.loadRun(run.id)).run.status).toBe('queued')
      await scheduler.tick()
      await scheduler.drain()
      expect(attempts).toEqual([run.id, run.id])
    } finally {
      scheduler.stop()
      await scheduler.drain()
      await f.close()
    }
  }, 10000)

  it.each(['connection_authorization_expired', 'managed_model_unavailable'])(
    'blocks setup failure %s once and retains charges for previously started requests',
    async (errorCode) => {
      const f = await fixture()
      const fresh = await f.service.submit(f.ownerId, f.conversation.id, await f.submission('Fresh'))
      const conversation = await f.service.createConversation(f.ownerId, f.agentId)
      const resumed = await f.service.submit(f.ownerId, conversation.id, await f.submission('Resumed'))
      await f.service.setStatus(resumed.id, 'running')
      const attempts: string[] = []
      const scheduler = createCloudScheduler(
        f.service,
        {
          run: async (id) => {
            attempts.push(id)
            throw new CloudError(409, errorCode)
          },
          stop: async () => {},
        },
        () => {},
      )
      try {
        await scheduler.tick()
        await scheduler.drain()
        const freshRun = (await f.service.loadRun(fresh.id)).run
        const resumedRun = (await f.service.loadRun(resumed.id)).run
        expect(freshRun.status).toBe('blocked')
        expect(freshRun.spentMicros).toBe(0)
        expect(resumedRun.status).toBe('blocked')
        expect(resumedRun.spentMicros).toBe(resumedRun.reservedMicros)
        expect(resumedRun.errorCode).toBe(errorCode)
        await scheduler.tick()
        await scheduler.drain()
        expect((await f.service.loadRun(fresh.id)).run.status).toBe('blocked')
        expect(attempts).toHaveLength(2)
      } finally {
        scheduler.stop()
        await scheduler.drain()
        await f.close()
      }
    },
    10000,
  )

  it('repairs changes that become visible behind the incremental timestamp cursor', async () => {
    const f = await fixture()
    f.settings.executionEnabled = false
    const clock = { value: new Date() }
    const scheduler = createCloudScheduler(
      f.service,
      { run: async () => {}, stop: async () => {} },
      () => {},
      () => clock.value,
    )
    try {
      await scheduler.tick()
      const [initial] = await f.database
        .select()
        .from(cloudAgentProjections)
        .where(eq(cloudAgentProjections.id, `agent:${f.agentId}`))
      expect(initial!.payload).not.toContain('saveDigest')
      // This is the state exposed when a long-running transaction commits with a timestamp from before the scan.
      await f.database
        .update(cloudAgents)
        .set({ enabled: false, updatedAt: new Date(clock.value.getTime() - 10 * 60_000).toISOString() })
        .where(eq(cloudAgents.id, f.agentId))
      clock.value = new Date(clock.value.getTime() + 60_000)
      await scheduler.tick()
      const [incremental] = await f.database
        .select()
        .from(cloudAgentProjections)
        .where(eq(cloudAgentProjections.id, `agent:${f.agentId}`))
      expect(JSON.parse(incremental!.payload).enabled).toBe(true)
      clock.value = new Date(clock.value.getTime() + 5 * 60_000)
      await scheduler.tick()
      const [repaired] = await f.database
        .select()
        .from(cloudAgentProjections)
        .where(eq(cloudAgentProjections.id, `agent:${f.agentId}`))
      expect(JSON.parse(repaired!.payload).enabled).toBe(false)
    } finally {
      scheduler.stop()
      await scheduler.drain()
      await f.close()
    }
  }, 10000)

  it('coalesces missed schedule triggers and deduplicates the submit-to-advance crash gap', async () => {
    const f = await fixture()
    const id = crypto.randomUUID()
    const config = {
      name: 'Periodic',
      prompt: 'Check the garden',
      timezone: 'UTC',
      cadence: { type: 'interval', minutes: 30 },
    }
    const encrypted = await encryptScopedJson(config, f.key, {
      ownerId: f.ownerId,
      scopeId: cloudAgentScope(f.agentId),
      keyEpoch: 1,
      recordId: id,
      purpose: 'schedule',
    })
    await f.service.saveSchedule(f.ownerId, {
      id,
      agentId: f.agentId,
      expectedVersion: 0,
      enabled: true,
      keyEpoch: 1,
      config: encrypted,
    })
    const due = new Date(Date.now() - 3 * 3600_000).toISOString()
    await f.database.update(cloudSchedules).set({ nextRunAt: due }).where(eq(cloudSchedules.id, id))
    const scheduler = createCloudScheduler(
      f.service,
      {
        run: async (runId) => {
          await f.service.setStatus(runId, 'completed')
        },
        stop: async () => {},
      },
      () => {},
    )
    try {
      await scheduler.tick()
      await scheduler.drain()
      const [scheduled] = await f.database.select().from(cloudSchedules).where(eq(cloudSchedules.id, id))
      expect(Date.parse(scheduled!.nextRunAt!)).toBeGreaterThan(Date.now())
      expect(await f.database.select().from(cloudRuns).where(eq(cloudRuns.agentId, f.agentId))).toHaveLength(1)
      // Recreate the durable state before schedule advancement, after its idempotent submission committed.
      await f.database
        .update(cloudSchedules)
        .set({ nextRunAt: due, activeRunId: null })
        .where(eq(cloudSchedules.id, id))
      await scheduler.tick()
      await scheduler.drain()
      expect(await f.database.select().from(cloudRuns).where(eq(cloudRuns.agentId, f.agentId))).toHaveLength(1)
    } finally {
      scheduler.stop()
      await scheduler.drain()
      await f.close()
    }
  }, 10000)
})
