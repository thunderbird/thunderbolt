/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const defaultBaseDelayMs = 1_000
const defaultMaxDelayMs = 30_000
const defaultMaxAttempts = 6
const defaultMaxConcurrent = 2
// A connection must stay up this long before the retry budget resets. The CLI
// bridge spawns one agent subprocess per accepted connection, so a bridge
// that accepts then dies moments later (crash loop) must keep draining the
// budget instead of earning a fresh immediate redial on every cycle.
const defaultStabilityWindowMs = 30_000

type Timer = ReturnType<typeof setTimeout>

type ReconnectRecord = {
  attempts: number
  reconnect: () => Promise<void>
  running: boolean
  timer: Timer | null
}

/** Success memory that outlives a record's unregister, keyed by agent. */
type RecentSuccess = {
  attempts: number
  succeededAt: number
}

type EventTargetLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

export type ReconnectSchedulerOptions = {
  baseDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
  maxConcurrent?: number
  stabilityWindowMs?: number
  random?: () => number
  isVisible?: () => boolean
  isOnline?: () => boolean
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  visibilityTarget?: EventTargetLike
  onlineTarget?: EventTargetLike
}

export type ReconnectSchedulerLike = Pick<ReconnectScheduler, 'register' | 'unregister' | 'wake'>

/** Schedules bounded, coalesced adapter rebuilds while the app can use them. */
export class ReconnectScheduler {
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number
  private readonly maxConcurrent: number
  private readonly stabilityWindowMs: number
  private readonly random: () => number
  private readonly isVisible: () => boolean
  private readonly isOnline: () => boolean
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly visibilityTarget?: EventTargetLike
  private readonly onlineTarget?: EventTargetLike
  private readonly records = new Map<string, ReconnectRecord>()
  private readonly recentSuccesses = new Map<string, RecentSuccess>()
  private readonly permitWaiters: Array<() => void> = []
  private activePermits = 0

  constructor(options: ReconnectSchedulerOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? defaultBaseDelayMs
    this.maxDelayMs = options.maxDelayMs ?? defaultMaxDelayMs
    this.maxAttempts = options.maxAttempts ?? defaultMaxAttempts
    this.maxConcurrent = options.maxConcurrent ?? defaultMaxConcurrent
    this.stabilityWindowMs = options.stabilityWindowMs ?? defaultStabilityWindowMs
    this.random = options.random ?? Math.random
    this.isVisible =
      options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible')
    this.isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine)
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.visibilityTarget = options.visibilityTarget ?? (typeof document === 'undefined' ? undefined : document)
    this.onlineTarget = options.onlineTarget ?? (typeof window === 'undefined' ? undefined : window)
    this.visibilityTarget?.addEventListener('visibilitychange', this.handleWakeEvent)
    this.onlineTarget?.addEventListener('online', this.handleWakeEvent)
  }

  /** Register a failed adapter and start its recovery attempt. */
  register(agentId: string, reconnect: () => Promise<void>): void {
    const existing = this.records.get(agentId)
    if (existing && !existing.running) {
      existing.reconnect = reconnect
      this.wake(agentId)
      return
    }

    if (existing?.timer) {
      this.clearTimer(existing.timer)
    }
    const record: ReconnectRecord = {
      attempts: this.seedAttempts(agentId),
      reconnect,
      running: false,
      timer: null,
    }
    this.records.set(agentId, record)
    if (record.attempts === 0) {
      this.scheduleImmediate(agentId)
      return
    }
    this.scheduleRetry(agentId, record)
  }

  /** Cancel all pending recovery work for one adapter. */
  unregister(agentId: string): void {
    const record = this.records.get(agentId)
    if (!record) {
      return
    }
    if (record.timer) {
      this.clearTimer(record.timer)
    }
    this.records.delete(agentId)
  }

  /** Wake one adapter (manual retry), or every registered adapter after a
   *  browser event. A manual wake resets the full retry budget; a browser
   *  event grants an exhausted recovery exactly one coalesced attempt —
   *  enough to catch a bridge that came back while paused — instead of a
   *  fresh budget per refocus or network flap. */
  wake(agentId?: string): void {
    const targeted = agentId !== undefined
    const ids = targeted ? [agentId] : [...this.records.keys()]
    for (const id of ids) {
      const record = this.records.get(id)
      if (!record) {
        continue
      }
      record.attempts = this.wakeAttempts(record.attempts, targeted)
      this.scheduleImmediate(id)
    }
  }

  /** Budget granted by a wake: a targeted manual retry resets fully, while a
   *  browser-event broadcast leaves an exhausted record one attempt short of
   *  the cap so a failure re-exhausts (and re-logs the pause) immediately. */
  private wakeAttempts(attempts: number, targeted: boolean): number {
    if (targeted || attempts < this.maxAttempts) {
      return 0
    }
    return this.maxAttempts - 1
  }

  /** Remove browser listeners and cancel every scheduled reconnect. */
  dispose(): void {
    for (const agentId of [...this.records.keys()]) {
      this.unregister(agentId)
    }
    this.recentSuccesses.clear()
    this.visibilityTarget?.removeEventListener('visibilitychange', this.handleWakeEvent)
    this.onlineTarget?.removeEventListener('online', this.handleWakeEvent)
  }

  private readonly handleWakeEvent = (): void => {
    this.wake()
  }

  /** Retry budget carried over from a recent success: a connection that died
   *  younger than the stability window counts as one more unstable cycle and
   *  continues the backoff progression; anything older starts fresh. */
  private seedAttempts(agentId: string): number {
    const success = this.recentSuccesses.get(agentId)
    if (!success) {
      return 0
    }
    if (Date.now() - success.succeededAt >= this.stabilityWindowMs) {
      this.recentSuccesses.delete(agentId)
      return 0
    }
    return success.attempts + 1
  }

  private canAttempt(): boolean {
    return this.isVisible() && this.isOnline()
  }

  private scheduleImmediate(agentId: string): void {
    const record = this.records.get(agentId)
    if (!record || record.running) {
      return
    }
    if (record.timer) {
      this.clearTimer(record.timer)
    }
    record.timer = this.setTimer(() => void this.run(agentId, record), 0)
  }

  private scheduleRetry(agentId: string, record: ReconnectRecord): void {
    if (record.attempts >= this.maxAttempts) {
      console.error(
        'ACP background recovery paused after exhausting attempts; will retry on tab refocus, network recovery, or manual retry',
        agentId,
      )
      return
    }
    const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (record.attempts - 1))
    record.timer = this.setTimer(() => void this.run(agentId, record), this.random() * cap)
  }

  private async run(agentId: string, record: ReconnectRecord): Promise<void> {
    if (this.records.get(agentId) !== record) {
      return
    }
    record.timer = null
    if (record.running || !this.canAttempt()) {
      return
    }

    record.running = true
    try {
      const attempted = await this.withPermit(async () => {
        if (this.records.get(agentId) !== record || !this.canAttempt()) {
          return false
        }
        await record.reconnect()
        return true
      })
      if (attempted && this.records.get(agentId) === record) {
        this.recentSuccesses.set(agentId, { attempts: record.attempts, succeededAt: Date.now() })
        this.unregister(agentId)
      }
    } catch (error) {
      if (this.records.get(agentId) === record) {
        record.attempts += 1
        console.warn('ACP background reconnect attempt failed', agentId, record.attempts, error)
        this.scheduleRetry(agentId, record)
      }
    } finally {
      record.running = false
    }
  }

  private async withPermit<T>(task: () => Promise<T>): Promise<T> {
    await this.acquirePermit()
    try {
      return await task()
    } finally {
      this.releasePermit()
    }
  }

  private acquirePermit(): Promise<void> {
    if (this.activePermits < this.maxConcurrent) {
      this.activePermits += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => this.permitWaiters.push(resolve))
  }

  private releasePermit(): void {
    const next = this.permitWaiters.shift()
    if (next) {
      next()
      return
    }
    this.activePermits -= 1
  }
}

export const reconnectScheduler = new ReconnectScheduler()
