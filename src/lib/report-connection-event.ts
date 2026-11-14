/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useHttpClient } from '@/contexts/http-client-context'
import type { HttpClient } from '@/lib/http'

/** A change to one of the user's own connections that the server can't see: it happens on the device. */
export type ConnectionEvent = {
  action:
    | 'user_connection.added'
    | 'user_connection.updated'
    | 'user_connection.removed'
    | 'user_connection.credential_replaced'
  target: { type: 'provider_connection' | 'mcp_server' | 'integration'; id: string }
  provider?: string
  authMethod?: 'oauth' | 'api_key' | 'none'
}

/**
 * Report a connection change to the organization's audit log, where it is labelled
 * client-reported. Best effort: the change is already made on the device, so a report that fails
 * (offline, say) is dropped with a warning, never retried or surfaced. Never put a URL, name or
 * credential in it; the backend accepts ids and enums only.
 */
export const reportConnectionEvent = (httpClient: HttpClient, event: ConnectionEvent) => {
  void (async () => {
    try {
      await httpClient.post('audit/client-events', { json: event })
    } catch (error) {
      console.warn('Could not report a connection change to the audit log', error)
    }
  })()
}

/** `reportConnectionEvent` bound to the app's authenticated client. */
export const useReportConnectionEvent = () => {
  const httpClient = useHttpClient()
  return (event: ConnectionEvent) => reportConnectionEvent(httpClient, event)
}
