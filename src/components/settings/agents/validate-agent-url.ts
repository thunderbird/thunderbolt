/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CustomAgentTransport } from '@/dal/agents'
import { isIrohTarget } from '@/lib/iroh-target'
import { getPlatform, isTauri } from '@/lib/platform'

/** Maps a user-entered endpoint to the ACP transport flavor we support, or `null`
 *  when it is neither a `ws(s)://` URL nor an iroh NodeId/ticket. HTTP/HTTPS and
 *  other schemes are rejected. */
export const inferTransport = (url: string): CustomAgentTransport | null => {
  if (isIrohTarget(url)) {
    return 'iroh'
  }
  try {
    const u = new URL(url)
    if (u.protocol === 'ws:' || u.protocol === 'wss:') {
      return 'websocket'
    }
    return null
  } catch {
    return null
  }
}

/** True when running on iOS via Tauri — Apple's App Transport Security rejects
 *  cleartext (`ws://`) by default, so we surface a clear error upfront instead
 *  of letting the connection silently fail. */
const defaultIsTauriIOS = (): boolean => isTauri() && getPlatform() === 'ios'

/** Pure validation of `url` against the platform's transport rules. Returns
 *  the inferred transport on success, or a user-facing error string. */
export const validateAgentUrl = (
  url: string,
  isIos: () => boolean = defaultIsTauriIOS,
): { transport: CustomAgentTransport } | { error: string } => {
  const transport = inferTransport(url)
  if (!transport) {
    // ws:// is accepted too (except on iOS, below) for LAN/dev agents without
    // TLS — the copy leads with wss:// because that's what remote endpoints
    // should use.
    return { error: 'Enter a wss:// or ws:// URL, or an iroh ticket' }
  }
  // iroh dials QUIC over an encrypted relay (no cleartext) and its target isn't a
  // URL, so the iOS ATS guard only applies to a `ws://` WebSocket endpoint.
  if (transport === 'websocket' && isIos() && new URL(url).protocol === 'ws:') {
    return { error: 'iOS requires a secure URL (wss://)' }
  }
  return { transport }
}
