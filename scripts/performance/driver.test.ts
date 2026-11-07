/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, mock, test } from 'bun:test'
import type { Locator, Page } from '@playwright/test'
import { clickAction } from './driver'

test.each([390, 1440])(
  'prepares actionability before dispatching measured pointer input at width %i',
  async (width) => {
    const trial = mock(async () => {})
    const tap = mock(async () => {})
    const click = mock(async () => {})
    const page = { viewportSize: () => ({ width }), touchscreen: { tap }, mouse: { click } } as unknown as Page
    const locator = {
      click: trial,
      boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 60 }),
    } as unknown as Locator
    const action = await clickAction(page, locator)
    expect(trial).toHaveBeenCalledWith({ trial: true })
    expect(tap).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    await action()
    expect(width < 768 ? tap : click).toHaveBeenCalledWith(30, 50)
  },
)
