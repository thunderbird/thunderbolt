/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm'
import { cloudAgents, cloudConversations, cloudRuns, cloudSchedules } from '@/db/cloud-agent-schema'
import { cloudAgentScope } from '@shared/cloud-agent/contracts'
import { decryptScopedJson, encryptScopedJson } from '@shared/cloud-agent/crypto'
import { cloudScheduleConfigSchema } from '@shared/cloud-agent/validation'
import { activeRunStatuses, type CloudAgentService } from './service'
import { nextOccurrence, scheduleCommandId } from './schedule'
import { projectCloudChanges } from './projections'
import { CloudError } from './errors'

export type ScheduledRuntime = { run: (runId: string) => Promise<void>; stop: (runId: string) => Promise<void> }

/** One scanner admits work; Pi remains the sole owner of execution checkpoints and tool recovery. */
export const createCloudScheduler = (
  service: CloudAgentService,
  runtime: ScheduledRuntime,
  reportError: (code: string) => void,
  now: () => Date = () => new Date(),
) => {
  const active = new Map<string, { conversationId: string; promise: Promise<void> }>()
  const state = {
    closed: false,
    currentTick: null as Promise<void> | null,
    projectedThrough: '1970-01-01T00:00:00.000Z',
    lastFullProjectionAt: null as number | null,
  }
  const dispatchSchedules = async () => {
    const due = await service.database
      .select({ schedule: cloudSchedules })
      .from(cloudSchedules)
      .innerJoin(cloudAgents, eq(cloudSchedules.agentId, cloudAgents.id))
      .leftJoin(cloudRuns, eq(cloudSchedules.activeRunId, cloudRuns.id))
      .where(
        and(
          eq(cloudSchedules.enabled, true),
          or(isNull(cloudRuns.id), notInArray(cloudRuns.status, activeRunStatuses)),
          lte(cloudSchedules.nextRunAt, now().toISOString()),
          or(isNull(cloudSchedules.retryAt), lte(cloudSchedules.retryAt, now().toISOString())),
          eq(cloudAgents.enabled, true),
          isNull(cloudAgents.deletedAt),
        ),
      )
      .orderBy(asc(cloudSchedules.nextRunAt), asc(cloudSchedules.id))
      .limit(100)
    for (const { schedule } of due) {
      if (state.closed) {
        return
      }
      try {
        const agent = await service.getAgent(schedule.userId, schedule.agentId)
        const { key } = await service.openAgent(agent)
        const scope = { ownerId: agent.userId, scopeId: cloudAgentScope(agent.id), keyEpoch: schedule.keyEpoch }
        const config = cloudScheduleConfigSchema.parse(
          await decryptScopedJson(schedule.config, key, { ...scope, recordId: schedule.id, purpose: 'schedule' }),
        )
        const conversationId = config.conversationId ?? schedule.id
        // The schedule ID names its dedicated conversation, so a crash cannot create duplicates.
        if (!config.conversationId) {
          await service.database
            .insert(cloudConversations)
            .values({ id: conversationId, userId: agent.userId, agentId: agent.id })
            .onConflictDoNothing()
        }
        const commandId = scheduleCommandId(schedule.id, schedule.nextRunAt!)
        const content = await encryptScopedJson({ text: config.prompt }, key, {
          ...scope,
          recordId: commandId,
          purpose: 'submission',
        })
        const run = await service.submit(agent.userId, conversationId, { commandId, content, keyEpoch: agent.keyEpoch })
        // Retrying before this write submits the same occurrence; after it the next due time is authoritative.
        await service.database
          .update(cloudSchedules)
          .set({
            activeRunId: run.id,
            lastRunAt: schedule.nextRunAt,
            nextRunAt: nextOccurrence(config, now()),
            errorCode: null,
            retryAt: null,
            updatedAt: now().toISOString(),
          })
          .where(and(eq(cloudSchedules.id, schedule.id), eq(cloudSchedules.version, schedule.version)))
      } catch (error) {
        const errorCode = error instanceof CloudError ? error.code : 'cloud_schedule_dispatch_failed'
        // Keep the occurrence identity unchanged: a retry after an uncertain submission acknowledgement deduplicates safely.
        await service.database
          .update(cloudSchedules)
          .set({
            errorCode,
            retryAt: new Date(now().getTime() + 5 * 60_000).toISOString(),
            updatedAt: now().toISOString(),
          })
          .where(and(eq(cloudSchedules.id, schedule.id), eq(cloudSchedules.version, schedule.version)))
        reportError(errorCode)
      }
    }
  }
  const scan = async () => {
    const projectionStart = now().toISOString()
    const fullRepair =
      state.lastFullProjectionAt === null || Date.parse(projectionStart) - state.lastFullProjectionAt >= 5 * 60_000
    // A late transaction can commit behind any timestamp cursor. Periodic authoritative repair guarantees convergence.
    await projectCloudChanges(
      service.database,
      fullRepair ? '1970-01-01T00:00:00.000Z' : state.projectedThrough,
      fullRepair,
    )
    if (fullRepair) {
      state.lastFullProjectionAt = Date.parse(projectionStart)
    }
    // Overlap the query window so transactions committing after the scan are revisited.
    state.projectedThrough = new Date(Date.parse(projectionStart) - 60_000).toISOString()
    if (!service.settings.executionEnabled) {
      return
    }
    await dispatchSchedules()
    if (state.closed) {
      return
    }
    // Stop requests must not sit behind the admission limit or another conversation's queue.
    const stopping = await service.database
      .select()
      .from(cloudRuns)
      .where(eq(cloudRuns.status, 'stop-requested'))
      .orderBy(asc(cloudRuns.createdAt), asc(cloudRuns.id))
      .limit(500)
    for (const run of stopping) {
      if (state.closed) {
        return
      }
      await runtime.stop(run.id)
      if (!active.has(run.id)) {
        await service.setStatus(run.id, 'stopped')
      }
    }
    const remainingCapacity = service.settings.maxConcurrentRuns - active.size
    if (state.closed || remainingCapacity <= 0) {
      return
    }
    const occupiedConversations = [...active.values()].map((item) => item.conversationId)
    const pending = service.database
      .selectDistinctOn([cloudRuns.conversationId])
      .from(cloudRuns)
      .where(
        and(
          inArray(cloudRuns.status, activeRunStatuses),
          ne(cloudRuns.status, 'stop-requested'),
          occupiedConversations.length ? notInArray(cloudRuns.conversationId, occupiedConversations) : undefined,
        ),
      )
      // Resume an already-started turn before a queued follow-up, even when timestamps tie.
      .orderBy(
        cloudRuns.conversationId,
        sql`CASE WHEN ${cloudRuns.status} = 'queued' THEN 1 ELSE 0 END`,
        asc(cloudRuns.createdAt),
        asc(cloudRuns.id),
      )
      .as('pending_cloud_turns')
    const runs = await service.database
      .select()
      .from(pending)
      .orderBy(sql`CASE WHEN ${pending.status} = 'queued' THEN 1 ELSE 0 END`, asc(pending.createdAt), asc(pending.id))
      .limit(remainingCapacity)
    for (const run of runs) {
      if (state.closed) {
        return
      }
      if (active.has(run.id) || [...active.values()].some((item) => item.conversationId === run.conversationId)) {
        continue
      }
      if (active.size >= service.settings.maxConcurrentRuns) {
        break
      }
      const promise = runtime
        .run(run.id)
        .catch(async (error: unknown) => {
          reportError('cloud_run_failed')
          if (error instanceof CloudError) {
            // Setup cannot read durable accounting after a revoked grant. Previously started work keeps its full reservation.
            const chargedMicros =
              run.status === 'queued' && run.piSubmissionId === null
                ? run.spentMicros
                : Math.max(run.spentMicros, run.reservedMicros)
            await service.database
              .update(cloudRuns)
              .set({ spentMicros: chargedMicros })
              .where(and(eq(cloudRuns.id, run.id), inArray(cloudRuns.status, activeRunStatuses)))
            await service.setStatus(run.id, error.code === 'run_stopped' ? 'stopped' : 'blocked', error.code)
          }
        })
        .catch(() => reportError('cloud_run_settlement_failed'))
        .finally(() => {
          active.delete(run.id)
        })
      active.set(run.id, { conversationId: run.conversationId, promise })
    }
  }
  const tick = (): Promise<void> => {
    if (state.closed) {
      return Promise.resolve()
    }
    if (state.currentTick) {
      return state.currentTick
    }
    state.currentTick = scan().finally(() => {
      state.currentTick = null
    })
    return state.currentTick
  }
  const safeTick = async () => {
    try {
      await tick()
    } catch {
      reportError('cloud_scheduler_failed')
    }
  }
  const timer = setInterval(() => void safeTick(), 1000)
  return {
    tick,
    stop: () => {
      state.closed = true
      clearInterval(timer)
    },
    drain: async () => {
      await Promise.allSettled([state.currentTick])
      await Promise.allSettled([...active.values()].map((item) => item.promise))
    },
  }
}
