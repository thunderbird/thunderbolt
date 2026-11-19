/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type BrowserSample = {
  durationMs: number
  firstFrameMs: number | null
  framesMs: number[]
  longTasksMs: number[]
  events: {
    name: string
    startMs: number
    durationMs: number
    inputDelayMs: number
    processingMs: number
    presentationDelayMs: number
    interactionId: number
  }[]
  longAnimationFrames?: {
    startMs: number
    durationMs: number
    blockingMs: number
    scripts: {
      sourceURL: string
      sourceFunctionName: string
      invoker: string
      durationMs: number
      forcedStyleAndLayoutMs: number
    }[]
  }[]
  reactCommits: number
  supportedEntryTypes: readonly string[]
}

export type Probe = { start: () => void; stop: () => BrowserSample }

export type PerformanceWindow = Window & { __thunderboltPerformance: Probe }

/** Injected only by the browser harness; no instrumentation ships in the app. */
export const installProbe = (startImmediately = false) => {
  const state = {
    active: false,
    startedAt: 0,
    previousFrame: 0,
    firstFrameMs: null as number | null,
    frame: 0,
    commits: 0,
    frames: [] as number[],
    longTasks: [] as number[],
    events: [] as BrowserSample['events'],
    longAnimationFrames: [] as NonNullable<BrowserSample['longAnimationFrames']>,
  }
  const supportedEntryTypes = PerformanceObserver.supportedEntryTypes
  const record = (entries: PerformanceEntry[]) => {
    if (!state.active) {
      return
    }
    for (const entry of entries) {
      if (entry.startTime < state.startedAt) {
        continue
      }
      if (entry.entryType === 'longtask') {
        state.longTasks.push(entry.duration)
      }
      if (entry.entryType === 'event') {
        const event = entry as PerformanceEventTiming
        if (!event.interactionId) {
          continue
        }
        state.events.push({
          name: event.name,
          startMs: event.startTime - state.startedAt,
          durationMs: event.duration,
          inputDelayMs: event.processingStart - event.startTime,
          processingMs: event.processingEnd - event.processingStart,
          // Event Timing duration is rounded to 8 ms, so its inferred presentation portion can be negative.
          presentationDelayMs: Math.max(0, event.startTime + event.duration - event.processingEnd),
          interactionId: event.interactionId,
        })
      }
      if (entry.entryType === 'long-animation-frame') {
        const frame = entry as PerformanceEntry & {
          blockingDuration: number
          scripts: {
            sourceURL: string
            sourceFunctionName: string
            invoker: string
            duration: number
            forcedStyleAndLayoutDuration: number
          }[]
        }
        state.longAnimationFrames.push({
          startMs: frame.startTime - state.startedAt,
          durationMs: frame.duration,
          blockingMs: frame.blockingDuration,
          scripts: frame.scripts.map((script) => ({
            sourceURL: script.sourceURL,
            sourceFunctionName: script.sourceFunctionName,
            invoker: script.invoker,
            durationMs: script.duration,
            forcedStyleAndLayoutMs: script.forcedStyleAndLayoutDuration,
          })),
        })
      }
    }
  }
  const observers = ['longtask', 'event', 'long-animation-frame']
    .filter((type) => supportedEntryTypes.includes(type))
    .map((type) => {
      const observer = new PerformanceObserver((list) => record(list.getEntries()))
      const options: PerformanceObserverInit & { durationThreshold?: number } =
        type === 'event' ? { type, durationThreshold: 16 } : { type }
      observer.observe(options)
      return observer
    })
  const tick = (at: number) => {
    if (state.firstFrameMs === null) {
      state.firstFrameMs = performance.now() - state.startedAt
    }
    if (state.previousFrame) {
      state.frames.push(at - state.previousFrame)
    }
    state.previousFrame = at
    state.frame = requestAnimationFrame(tick)
  }

  // Count root commits without walking the Fiber tree or enabling the slower React profiling build.
  Object.assign(window, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: () => {
        if (state.active) {
          state.commits++
        }
      },
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
    },
  })
  const probe: Probe = {
    start: () => {
      observers.forEach((observer) => observer.takeRecords())
      state.startedAt = performance.now()
      state.previousFrame = 0
      state.firstFrameMs = null
      state.commits = 0
      state.frames = []
      state.longTasks = []
      state.events = []
      state.longAnimationFrames = []
      state.active = true
      state.frame = requestAnimationFrame(tick)
    },
    stop: () => {
      observers.forEach((observer) => record(observer.takeRecords()))
      state.active = false
      cancelAnimationFrame(state.frame)
      return {
        durationMs: performance.now() - state.startedAt,
        firstFrameMs: state.firstFrameMs,
        framesMs: state.frames,
        longTasksMs: state.longTasks,
        events: state.events,
        longAnimationFrames: state.longAnimationFrames,
        reactCommits: state.commits,
        supportedEntryTypes,
      }
    },
  }
  Object.assign(window, { __thunderboltPerformance: probe })
  if (startImmediately) {
    probe.start()
  }
}
