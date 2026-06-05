/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Public surface for the ACP client library.
 *
 * Consumers (currently `src/chats/chat-instance.ts`) should only import from
 * this entry point. Internal modules (transports, translator) are not
 * re-exported — they're implementation details that may move.
 */

export { connectToAgent, type ConnectToAgentContext, type ConnectToAgentDeps } from './connect'
export { createBuiltInAdapter } from './built-in-adapter'
export { connectAcpAdapter } from './acp-adapter'
export { testAcpConnection } from './connection-test'
export type { AcpTransport, AiSdkChunk } from './types'
