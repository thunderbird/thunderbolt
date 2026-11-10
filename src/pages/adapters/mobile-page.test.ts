/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it } from 'bun:test'
import { measureMobilePage } from './mobile-page'

const mounts: HTMLElement[] = []
afterEach(() => mounts.splice(0).forEach((element) => element.remove()))

const surface = (rect: DOMRect, clip?: string) => {
  const host = document.createElement('div')
  host.dataset.pageHost = 'mobile-page'
  if (clip) {
    host.style.clipPath = clip
  }
  const element = document.createElement('div')
  element.getBoundingClientRect = () => rect
  host.append(element)
  document.body.append(host)
  mounts.push(host)
  return element
}

it('preserves the full viewport when transcript clipping hides part of a native page', () => {
  const element = surface(new DOMRect(20, -100, 320, 500), 'inset(140px 12px 60px 4px)')
  expect(measureMobilePage(element)).toEqual({
    x: 20,
    y: -100,
    width: 320,
    height: 500,
    clip: { top: 140, right: 12, bottom: 60, left: 4 },
  })
})

it('clamps a fully scrolled-off page without negative native view dimensions', () => {
  const element = surface(new DOMRect(0, -700, 320, 500), 'inset(700px 0px 0px 0px)')
  expect(measureMobilePage(element).clip).toEqual({ top: 500, right: 0, bottom: 0, left: 0 })
})

it('clips to the viewport when no permanent host clip has been computed yet', () => {
  const element = surface(new DOMRect(-10, -20, 200, 300))
  expect(measureMobilePage(element).clip).toEqual({ top: 20, right: 0, bottom: 0, left: 10 })
})
