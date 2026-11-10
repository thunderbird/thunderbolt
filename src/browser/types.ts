/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type BrowserRect = { x: number; y: number; width: number; height: number }
export type BrowserTabInfo = { id: string; url: string; title: string; isLoading: boolean; active: boolean }
export type BrowserElement = {
  ref: string
  tag: string
  role: string
  name: string
  text?: string
  rect: BrowserRect
  value?: string
}
export type BrowserSnapshot = {
  tabId: string
  url: string
  title: string
  documentId: string
  viewport: { width: number; height: number; scrollX: number; scrollY: number }
  text: string
  elements: BrowserElement[]
  screenshot?: { data: string; mediaType: 'image/png'; width?: number; height?: number }
  warnings?: string[]
  capabilities?: { nativeInput: boolean; screenshot: boolean }
}
export type BrowserAction =
  | { type: 'click' | 'move'; ref?: string; x?: number; y?: number; button?: 'left' | 'right' }
  | { type: 'type'; text: string; ref?: string; clear?: boolean }
  | { type: 'key'; key: string }
  | { type: 'scroll'; x?: number; y?: number; deltaX?: number; deltaY: number }
