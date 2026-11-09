/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDeviceById } from '@/dal'
import type { db as DbType } from '@/db/client'

type CallerDeviceResult =
  | { status: 400 | 403 | 404; error: string }
  | { deviceId: string; device: NonNullable<Awaited<ReturnType<typeof getDeviceById>>> }

/** The session fields the caller gate reads. Narrowed so callers pass anything session-shaped. */
type CallerSession = { deviceId?: string | null }

/**
 * Resolve the caller's device: the `X-Device-ID` header must be present AND
 * match the device this session is bound to server-side. The device must belong
 * to the authenticated user and not be revoked. Trust is NOT required here —
 * routes that need a trusted caller check `device.trusted` themselves.
 *
 * THU-873: the header is client-set, so on its own it is a CLAIM, not an
 * identity — any session could name any device and inherit its authority. The
 * authority is `session.deviceId`, which is written only by the sealed-nonce
 * bind handshake (`POST /devices/me/bind`) and by first registration. A session
 * that was never bound fails closed rather than falling back to the header.
 *
 * The match is checked BEFORE the device lookup, so a session cannot probe which
 * device ids exist on its own account either.
 */
export const getCallerDevice = async (
  database: typeof DbType,
  userId: string,
  request: Request,
  session: CallerSession,
): Promise<CallerDeviceResult> => {
  const deviceId = request.headers.get('x-device-id')?.trim()
  if (!deviceId) {
    return { status: 400, error: 'X-Device-ID header is required' }
  }
  if (!session.deviceId) {
    return { status: 403, error: 'Session is not bound to a device' }
  }
  if (session.deviceId !== deviceId) {
    return { status: 403, error: 'X-Device-ID does not match the authenticated device' }
  }
  const device = await getDeviceById(database, deviceId)
  if (!device || device.userId !== userId) {
    return { status: 404, error: 'Device not found' }
  }
  if (device.revokedAt != null) {
    return { status: 403, error: 'Device has been revoked' }
  }
  return { deviceId, device }
}
