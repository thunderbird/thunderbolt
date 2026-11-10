/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import type { PageRect } from '@shared/page-protocol'
import { pageObservationSchema } from '../page-observation'

export type MobilePageBounds = PageRect & { clip?: { top: number; right: number; bottom: number; left: number } }
const stateSchema = z.object({
  url: z.string().max(8192),
  title: z.string().transform((value) => value.slice(0, 500)),
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  faviconUrls: z.array(z.string()).max(32),
  error: z.string().nullable().optional(),
})

/** Native bridge endpoints expose fixed operations and never accept page-supplied scripts. */
export const mobilePage = {
  capabilities: () =>
    invoke<{ available: boolean; nativeInput: false; screenshot: false; isolatedSession: boolean }>(
      'plugin:pages|capabilities',
    ),
  create: (label: string, url: string, bounds: MobilePageBounds, hidden: boolean) =>
    invoke<void>('plugin:pages|create', { label, url, bounds, hidden }),
  present: (label: string, bounds: MobilePageBounds, visible: boolean) =>
    invoke<void>('plugin:pages|present', { label, bounds, visible }),
  navigate: (label: string, url: string) => invoke<void>('plugin:pages|navigate', { label, url }),
  action: (label: string, action: 'back' | 'forward' | 'reload' | 'stop') =>
    invoke<void>('plugin:pages|action', { label, action }),
  state: async (label: string) => stateSchema.parse(await invoke('plugin:pages|state', { label })),
  close: (label: string) => invoke<void>('plugin:pages|close', { label }),
  snapshot: async (label: string) => pageObservationSchema.parse(await invoke('plugin:pages|snapshot', { label })),
  setPicker: (label: string, enabled: boolean, requestId: string) =>
    invoke<void>('plugin:pages|set_picker', { label, enabled, requestId }),
  pollPicker: (label: string, requestId: string) => invoke<unknown>('plugin:pages|poll_picker', { label, requestId }),
}

/** Preserve the full page viewport while clipping the native sibling to its DOM slot. */
export const measureMobilePage = (element: HTMLElement): MobilePageBounds => {
  const rect = element.getBoundingClientRect()
  const host = element.closest<HTMLElement>('[data-page-host]')
  const insets = host?.style.clipPath.match(/^inset\(([\d.]+)px ([\d.]+)px ([\d.]+)px ([\d.]+)px\)$/)
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const top = Math.min(height, insets ? Number(insets[1]) : Math.max(0, -rect.top))
  const right = Math.min(width, insets ? Number(insets[2]) : Math.max(0, rect.right - window.innerWidth))
  const bottom = Math.min(height - top, insets ? Number(insets[3]) : Math.max(0, rect.bottom - window.innerHeight))
  const left = Math.min(width - right, insets ? Number(insets[4]) : Math.max(0, -rect.left))
  return { x: rect.x, y: rect.y, width, height, clip: { top, right, bottom, left } }
}
