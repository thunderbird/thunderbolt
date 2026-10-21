/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Startup-timing collector.
 *
 * Dependency-free on purpose: `index.tsx` records marks here at module-eval
 * time without pulling anything extra into the entry path. All marks are
 * `performance.now()` offsets from `performance.timeOrigin` (navigation
 * start), so they compose with the per-step durations recorded by the init
 * pipeline into a single timeline.
 *
 * The payload is sent to PostHog as one `app_init_timing` event after the
 * init pipeline finishes (the PostHog client only exists from step 8 on),
 * plus a one-shot `app_chat_ready` event on first chat hydration.
 */

type InitTimingState = {
  initRun: number
  bundleEvaluatedMs: number | null
  appMountedMs: number | null
  chatReadyMs: number | null
  contentReadyMs: number | null
  spinnerMountedMs: number | null
  stepDurations: Record<string, number>
}

const state: InitTimingState = {
  initRun: 0,
  bundleEvaluatedMs: null,
  appMountedMs: null,
  chatReadyMs: null,
  contentReadyMs: null,
  spinnerMountedMs: null,
  stepDurations: {},
}

/** Marks spinner commit; a trace is still needed to establish its actual first painted frame. */
export const markSpinnerMounted = (): void => {
  if (state.spinnerMountedMs !== null) {
    return
  }
  state.spinnerMountedMs = performance.now()
  performance.mark('thunderbolt:spinner-mounted')
}

/** Marks committed chat content after a rendering opportunity, once per page. */
export const markContentReady = (): Record<string, number | null> | null => {
  if (state.contentReadyMs !== null) {
    return null
  }
  state.contentReadyMs = performance.now()
  performance.mark('thunderbolt:content-ready')
  const payload = {
    content_ready_ms: Math.round(state.contentReadyMs),
    spinner_to_content_ms:
      state.spinnerMountedMs === null ? null : Math.round(state.contentReadyMs - state.spinnerMountedMs),
  }
  console.info(`[startup] content ready ${JSON.stringify(payload)}`)
  return payload
}

/**
 * Records when the entry module graph finished evaluating (called at the top
 * of the `index.tsx` body, i.e. after every static import ran). First call wins.
 */
export const markBundleEvaluated = (): void => {
  state.bundleEvaluatedMs ??= performance.now()
}

/** Records the first render of the root `App` component. First call wins. */
export const markAppMounted = (): void => {
  state.appMountedMs ??= performance.now()
}

/**
 * Starts a new init-pipeline run: bumps the run counter and clears step
 * durations from any previous run (e.g. a retry after an init error).
 */
export const beginInitRun = (): void => {
  state.initRun += 1
  state.stepDurations = {}
}

/** Captures the active run so async work can report only to the run that started it. */
export const getInitRun = (): number => state.initRun

/** Records a step duration unless the initialization that started it has been superseded. */
export const recordInitStep = (label: string, durationMs: number, initRun: number = state.initRun): void => {
  if (initRun !== state.initRun) {
    return
  }
  state.stepDurations[label] = durationMs
}

/**
 * Marks the first usable chat render. Returns the elapsed ms since navigation
 * start on the first call, and null afterwards (one event per session).
 */
export const markChatReady = (): number | null => {
  if (state.chatReadyMs !== null) {
    return null
  }
  state.chatReadyMs = performance.now()
  return state.chatReadyMs
}

/**
 * Builds the `app_init_timing` event payload: phase marks plus one
 * `<label>_ms` property per recorded step, all rounded to whole ms.
 */
export const getInitTimingPayload = (): Record<string, number | null> => {
  const steps = Object.fromEntries(
    Object.entries(state.stepDurations).map(([label, ms]) => [`${label}_ms`, Math.round(ms)]),
  )
  return {
    init_run: state.initRun,
    bundle_evaluated_ms: state.bundleEvaluatedMs === null ? null : Math.round(state.bundleEvaluatedMs),
    app_mounted_ms: state.appMountedMs === null ? null : Math.round(state.appMountedMs),
    ...steps,
  }
}

/** Resets all collected state — for testing only. */
export const resetInitTiming = (): void => {
  state.initRun = 0
  state.bundleEvaluatedMs = null
  state.appMountedMs = null
  state.chatReadyMs = null
  state.contentReadyMs = null
  state.spinnerMountedMs = null
  state.stepDurations = {}
}
