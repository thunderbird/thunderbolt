/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/contexts'
import { getDevice } from '@/dal/devices'
import { getDb } from '@/db/database'
import { getDeviceId } from '@/lib/auth-token'

/** The slice of the authenticated app client the enrollment calls need. Narrowed to
 *  `post` so tests can pass a tiny fake instead of a whole HttpClient (DI over module
 *  mocking). The real client attaches the bearer token + X-Device-ID automatically. */
type EnrollClient = Pick<HttpClient, 'post'>

export type EnsureSelfEnrollmentDeps = {
  /** Test/DI seam. `undefined` means the own device row is unavailable locally. */
  loadOwnNodeId?: (deviceId: string) => Promise<string | null | undefined>
  /** Test/DI seam for the same device identity source used by X-Device-ID. */
  loadDeviceId?: () => string
}

const enrolledDeviceNodeIds = new Set<string>()
const unavailableLookupAttempts = new Set<string>()
const enrollmentsInFlight = new Map<string, Promise<void>>()

/** Read this app instance's synced device row. Missing row means sync has not made
 *  the own-device state available yet; a present row may intentionally have null nodeId. */
const loadOwnNodeId = async (deviceId: string): Promise<string | null | undefined> => {
  const ownDevice = await getDevice(getDb(), deviceId).get()
  return ownDevice?.nodeId
}

/** Treat local DB/query failures as unavailable sync state. Enrollment remains
 *  best-effort through the idempotent backend route. */
const readOwnNodeId = async (
  deviceId: string,
  load: (deviceId: string) => Promise<string | null | undefined>,
): Promise<string | null | undefined> => {
  try {
    return await load(deviceId)
  } catch {
    return undefined
  }
}

/**
 * Self-enroll THIS app's iroh dialer NodeId into the account's device allowlist when an
 * iroh ACP agent or MCP bridge is added, so a same-account bridge auto-allows it without
 * the user running `thunderbolt iroh allow <node-id>`.
 *
 * Writes the caller's OWN `node_id` via the lightweight self-enroll route
 * (`POST /devices/me/node-id`, no canary): proof-of-possession happens at the iroh QUIC
 * handshake on connect, so declaring a NodeId you can't dial as grants nothing. The route
 * pins the write to the session's bound device, so this can only enroll the app itself.
 *
 * The bridge registers its own bare NodeId with the backend at boot through
 * `POST /devices/bridge`. The app must not register the user-entered dial target because it
 * may be a full EndpointTicket rather than a bare NodeId.
 *
 * Optimistic and throwing on purpose: callers run this best-effort and, on failure
 * (Standalone / no account / offline), fall back to the manual pairing command still shown
 * in the add dialog. Enrollment must never block the add.
 *
 * @param httpClient Authenticated app client (bearer + X-Device-ID attached by the client).
 * @param loadNodeId Test/DI seam for reading this app's NodeId; production lazy-loads the wasm.
 */
export const selfEnrollIrohNodeId = async (
  httpClient: EnrollClient,
  loadNodeId: () => Promise<string>,
): Promise<void> => {
  const nodeId = await loadNodeId()
  await httpClient.post('devices/me/node-id', { json: { nodeId } })
}

/**
 * Ensure this app instance's iroh dialer NodeId is enrolled before first use.
 *
 * Synced own-device state avoids a network call when its nodeId already matches.
 * Missing, null, or stale state triggers the idempotent self-enroll route. When
 * local state is unavailable, only one attempt per device + NodeId is made during
 * this app session. Successful/matching identities and concurrent calls are memoized.
 *
 * Failures warn and resolve so callers can continue through manual pairing.
 */
export const ensureSelfEnrollment = async (
  httpClient: EnrollClient,
  loadAppNodeId: () => Promise<string>,
  deps: EnsureSelfEnrollmentDeps = {},
): Promise<void> => {
  try {
    const nodeId = await loadAppNodeId()
    const deviceId = (deps.loadDeviceId ?? getDeviceId)()
    const enrollmentKey = `${deviceId}:${nodeId}`
    if (enrolledDeviceNodeIds.has(enrollmentKey)) {
      return
    }

    const existing = enrollmentsInFlight.get(enrollmentKey)
    if (existing) {
      await existing
      return
    }

    const pending = (async (): Promise<void> => {
      const ownNodeId = await readOwnNodeId(deviceId, deps.loadOwnNodeId ?? loadOwnNodeId)
      if (ownNodeId === nodeId) {
        enrolledDeviceNodeIds.add(enrollmentKey)
        return
      }

      if (ownNodeId === undefined) {
        if (unavailableLookupAttempts.has(enrollmentKey)) {
          return
        }
        unavailableLookupAttempts.add(enrollmentKey)
      }

      await httpClient.post('devices/me/node-id', { json: { nodeId } })
      enrolledDeviceNodeIds.add(enrollmentKey)
    })().finally(() => {
      if (enrollmentsInFlight.get(enrollmentKey) === pending) {
        enrollmentsInFlight.delete(enrollmentKey)
      }
    })

    enrollmentsInFlight.set(enrollmentKey, pending)
    await pending
  } catch {
    console.warn('iroh transparent enrollment failed; using manual pairing fallback')
  }
}

/** Reset session memoization between tests. */
export const resetSelfEnrollmentForTests = (): void => {
  enrolledDeviceNodeIds.clear()
  unavailableLookupAttempts.clear()
  enrollmentsInFlight.clear()
}
