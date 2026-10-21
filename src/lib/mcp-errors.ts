/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js'
import { ZodError } from 'zod/v4'
import { isUnauthorizedError } from './mcp-unauthorized-error'

export { isUnauthorizedError }

/** Expected SDK/transport and response-decoding failures. Only use at the
 * client.tools() IO boundary; keep application tool processing outside its catch. */
export const isMcpDiscoveryError = (err: unknown): err is Error => {
  if (!(err instanceof Error)) {
    return false
  }
  return (
    err instanceof UnauthorizedError ||
    err instanceof StreamableHTTPError ||
    err instanceof SseError ||
    err instanceof SyntaxError ||
    err instanceof ZodError ||
    /^Error POSTing to endpoint \(HTTP \d{3}\):/.test(err.message) ||
    err.name === 'MCPClientError' ||
    isUnauthorizedError(err) ||
    (err instanceof TypeError &&
      /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.)$/i.test(err.message))
  )
}
