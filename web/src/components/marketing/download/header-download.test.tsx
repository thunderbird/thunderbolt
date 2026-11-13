/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { renderToString } from 'react-dom/server'
import { render } from '../../../../test/render'
import { SparkHeader } from '../spark/spark-header'

const release = {
  tag_name: 'v1.2.3',
  draft: false,
  prerelease: false,
  assets: ['Thunderbolt_1.2.3_aarch64.dmg', 'Thunderbolt_1.2.3_x64-setup.exe', 'Thunderbolt_1.2.3_amd64.AppImage'].map(
    (name) => ({ name, state: 'uploaded' }),
  ),
}
let request: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
const originalAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
let userAgent = 'Macintosh'

beforeEach(() => {
  request = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(release))
  userAgent = 'Macintosh'
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => userAgent })
})
afterEach(() => {
  request.mockRestore()
  if (originalAgent) Object.defineProperty(navigator, 'userAgent', originalAgent)
  else Reflect.deleteProperty(navigator, 'userAgent')
})

/** Exercise the actual shared header, including its release refresh. */
const headerLink = async () => {
  const view = render(<SparkHeader />)
  await act(async () => {})
  return view.container.querySelector<HTMLAnchorElement>('.spark-nav-cta')!
}

test.each([
  ['Macintosh', 'mac-arm', 'Thunderbolt_1.2.3_aarch64.dmg'],
  ['Windows NT 10.0', 'windows-x64', 'Thunderbolt_1.2.3_x64-setup.exe'],
  ['X11; Linux x86_64', 'linux-appimage', 'Thunderbolt_1.2.3_amd64.AppImage'],
])('the %s header starts an installer and then continues to the download page', async (agent, id, filename) => {
  userAgent = agent
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {})
  try {
    const link = await headerLink()
    expect(link.href).toBe(`https://github.com/thunderbird/thunderbolt/releases/download/v1.2.3/${filename}`)
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener')
    const click = Object.assign(new Event('click', { bubbles: true, cancelable: true }), { button: 0 })
    act(() => link.dispatchEvent(click))
    expect(click.defaultPrevented).toBe(false)
    expect(assign).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(assign.mock.calls).toEqual([[`/download/?installer=${id}`]])
    expect(request.mock.calls[0][0]).toBe('/downloads/release.json')
  } finally {
    assign.mockRestore()
  }
})

test.each(['iPhone', 'Android', 'unknown'])(
  'the %s header offers the download page instead of a desktop installer',
  async (agent) => {
    userAgent = agent
    const link = await headerLink()
    expect(link.getAttribute('href')).toBe('/download/')
    expect(link.hasAttribute('target')).toBe(false)
  },
)

test('a missing platform installer offers the download page', async () => {
  request.mockResolvedValue(Response.json({ ...release, assets: [] }))
  const link = await headerLink()
  expect(link.getAttribute('href')).toBe('/download/')
  expect(link.hasAttribute('target')).toBe(false)
})

test('the server-rendered header remains a working download-page link without JavaScript', () => {
  const container = document.createElement('div')
  container.innerHTML = renderToString(<SparkHeader />)
  const link = container.querySelector('.spark-nav-cta')!
  expect(link.getAttribute('href')).toBe('/download/')
  expect(link.hasAttribute('target')).toBe(false)
  expect(request).not.toHaveBeenCalled()
})
