/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { PageAction } from '@shared/page-protocol'

const tabId = z.string().min(1).max(200)
const elementRef = z.string().min(1).max(200)
const coordinate = z.number().finite().min(0).max(100_000)
const scrollDelta = z.number().finite().min(-100_000).max(100_000)
export const actionSchema = z.object({
  tabId,
  type: z.enum(['click', 'move', 'type', 'key', 'scroll']),
  ref: elementRef.optional().describe('An element ref from a fresh snapshot of this same tab and document.'),
  x: coordinate.optional().describe('Horizontal CSS-pixel position inside the page viewport.'),
  y: coordinate.optional().describe('Vertical CSS-pixel position inside the page viewport.'),
  button: z.enum(['left', 'right']).optional(),
  text: z.string().max(20_000).optional().describe('Literal text to enter; never interpreted as code.'),
  clear: z.boolean().optional().describe('Clear the targeted field before typing.'),
  key: z.string().min(1).max(100).optional().describe('A key or chord such as Enter, Tab, Escape, or Control+a.'),
  deltaX: scrollDelta.optional(),
  deltaY: scrollDelta.optional().describe('Vertical scroll distance in CSS pixels; positive scrolls down.'),
})

/** Reject incomplete or ambiguous targets before an action reaches the native browser. */
export const actionFromInput = ({ tabId: _tabId, ...input }: z.infer<typeof actionSchema>): PageAction => {
  const hasPoint = input.x !== undefined && input.y !== undefined
  const hasPartialPoint = (input.x === undefined) !== (input.y === undefined)
  if (hasPartialPoint) {
    throw new Error('Provide both x and y for a viewport point.')
  }
  switch (input.type) {
    case 'click':
    case 'move': {
      if (Boolean(input.ref) === hasPoint) {
        throw new Error('Provide either an element ref or a viewport point, but not both.')
      }
      return {
        type: input.type,
        ...(input.ref ? { ref: input.ref } : { x: input.x, y: input.y }),
        ...(input.type === 'click' && input.button ? { button: input.button } : {}),
      }
    }
    case 'type':
      if (input.text === undefined) {
        throw new Error('Provide text for a type action.')
      }
      return { type: 'type', text: input.text, ref: input.ref, clear: input.clear }
    case 'key':
      if (!input.key) {
        throw new Error('Provide key for a key action.')
      }
      return { type: 'key', key: input.key }
    case 'scroll':
      if (input.deltaY === undefined) {
        throw new Error('Provide deltaY for a scroll action.')
      }
      return { type: 'scroll', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY }
  }
}
