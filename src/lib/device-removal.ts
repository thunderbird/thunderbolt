/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpError, type HttpClient } from '@/lib/http'

type RemoveDeviceResponse = {
  success: true
}

type RemoveDeviceErrorResponse = {
  error: string
}

/**
 * Permanently removes a revoked bridge device through the authenticated backend.
 */
export const removeRevokedBridgeDevice = async (
  httpClient: HttpClient,
  deviceId: string,
): Promise<RemoveDeviceResponse> => {
  try {
    return await httpClient.delete(`devices/${encodeURIComponent(deviceId)}`).json<RemoveDeviceResponse>()
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error
    }
    const response = (await error.response.json()) as RemoveDeviceErrorResponse
    throw new Error(response.error, { cause: error })
  }
}
