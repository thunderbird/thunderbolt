/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type SlotAdapter = {
  closed?: Promise<void>
  disconnect: () => void
}

export type AdapterSlotStatus = 'connecting' | 'ready' | 'terminated'

export type AdapterSlotTermination = {
  generation: number
  error?: unknown
}

export type AdapterSlotOptions = {
  onTerminated?: (termination: AdapterSlotTermination) => void
}

/** Owns one replaceable adapter generation and fences every async transition. */
export class AdapterSlot<TAdapter extends SlotAdapter> {
  private adapter: TAdapter | null = null
  private connectPending: Promise<TAdapter> | null = null
  private disposed = false
  private generationValue = 0
  private statusValue: AdapterSlotStatus = 'terminated'
  private readonly onTerminated: (termination: AdapterSlotTermination) => void

  constructor(options: AdapterSlotOptions = {}) {
    this.onTerminated = options.onTerminated ?? (() => {})
  }

  get generation(): number {
    return this.generationValue
  }

  get status(): AdapterSlotStatus {
    return this.statusValue
  }

  /** Return the ready generation or share one in-flight rebuild. */
  getOrConnect(connect: () => Promise<TAdapter>): Promise<TAdapter> {
    if (this.disposed) {
      return Promise.reject(new Error('Adapter slot is disposed'))
    }
    if (this.adapter) {
      return Promise.resolve(this.adapter)
    }
    if (this.connectPending) {
      return this.connectPending
    }

    const generation = this.generationValue + 1
    this.generationValue = generation
    this.statusValue = 'connecting'

    const pending = connect().then(
      (adapter) => {
        if (this.disposed || this.generationValue !== generation) {
          adapter.disconnect()
          throw new Error('Adapter generation was superseded')
        }

        this.adapter = adapter
        this.connectPending = null
        this.statusValue = 'ready'
        adapter.closed?.then(
          () => this.terminateGeneration(generation),
          (error: unknown) => this.terminateGeneration(generation, error),
        )
        return adapter
      },
      (error: unknown) => {
        if (!this.disposed && this.generationValue === generation) {
          this.connectPending = null
          this.statusValue = 'terminated'
        }
        throw error
      },
    )
    this.connectPending = pending
    return pending
  }

  /** Evict one dead generation without touching a newer replacement. */
  terminateGeneration(generation: number, error?: unknown): boolean {
    if (this.disposed || this.generationValue !== generation || this.statusValue !== 'ready') {
      return false
    }

    const adapter = this.adapter
    this.adapter = null
    this.statusValue = 'terminated'
    adapter?.disconnect()
    this.onTerminated({ generation, error })
    return true
  }

  /** Permanently stop this slot and disconnect its current or late adapter. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.connectPending?.catch(() => {})
      return
    }

    this.disposed = true
    this.generationValue += 1
    this.statusValue = 'terminated'
    const adapter = this.adapter
    const pending = this.connectPending
    this.adapter = null
    this.connectPending = null
    adapter?.disconnect()
    await pending?.catch(() => {})
  }
}
