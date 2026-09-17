/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Guest-side client for the Thunderbolt Mini App bridge.
 *
 * A Mini App is an ordinary web app that Thunderbolt embeds in an iframe. This
 * package is what it uses to talk back: publish context the chat can read,
 * expose tools the model can call, and let the user point at an element.
 *
 * This lived as four copied files inside each sample app, which is how two
 * copies came to differ by 400 lines while staying semantically identical.
 * One copy now.
 */

export {
  connect,
  isEmbedded,
  readTokenClaims,
  type AuthToken,
  type ConnectOptions,
  type Connection,
  type HostContext,
  type MiniAppContext,
  type Platform,
  type Theme,
  type TokenClaims,
} from './bridge'
export { callTool, toDescriptors, toWebMcpTools, type ThunderboltTool, type ToolCallResult } from './tools'
export { useThunderbolt, type ThunderboltState } from './use-thunderbolt'
export { elementAtPoint, type HighlightedElement, type Rect, type SelectionItem } from './selection-hit-test'
