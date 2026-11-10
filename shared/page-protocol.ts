/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Source provenance is optional: a saved HTML snapshot survives its source chat. */
export type PageArtifactReference = {
  messageId?: string
  toolCallId: string
  chatThreadId?: string | null
}

/** Content and local launch identities are independent of their display surface. */
export type PageSource =
  | { kind: 'url'; url: string }
  | { kind: 'html'; html: string; artifact?: PageArtifactReference }
  | { kind: 'local-app'; appId: string; projectId?: string }

export type PageDefinition = { id: string; title: string; source: PageSource }
export type PageChrome = 'browser' | 'app'
export type PagePresentation = 'inline' | 'sidebar' | 'expanded'
export type PageInputCapability = 'none' | 'synthetic' | 'native'

/** Advertised operations describe the actual adapter, not an assumed platform. */
export type PageCapabilities = {
  observe: boolean
  selectElement: boolean
  navigate: boolean
  declaredTools: boolean
  screenshot: boolean
  pointerInput: PageInputCapability
  keyboardInput: PageInputCapability
}

export type PageRect = { x: number; y: number; width: number; height: number }
export type PageElement = {
  ref: string
  tag: string
  role: string
  name: string
  text?: string
  rect: PageRect
  value?: string
}

/** References belong to one live document; changing presentation preserves that identity. */
export type PageSnapshot = {
  pageId: string
  sessionId: string
  documentId: string
  url: string
  title: string
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  text: string
  elements: PageElement[]
  screenshot?: { data: string; mediaType: 'image/png'; width?: number; height?: number }
  warnings?: string[]
  capabilities: PageCapabilities
}

export type PageAction =
  | { type: 'click' | 'move'; ref?: string; x?: number; y?: number; button?: 'left' | 'right' }
  | { type: 'type'; text: string; ref?: string; clear?: boolean }
  | { type: 'key'; key: string }
  | { type: 'scroll'; x?: number; y?: number; deltaX?: number; deltaY: number }

export type PageNavigation = { type: 'navigate'; url: string } | { type: 'back' | 'forward' | 'reload' | 'stop' }

export type PageSelection = {
  pageId: string
  sessionId: string
  documentId: string
  url: string
  title: string
  text: string
  ref?: string
  selector?: string
  rect?: PageRect
}
