/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { renderToString } from 'react-dom/server'
import { render } from '../../../../test/render'
import { SiteHeader } from '../spark/site-header'
import { SparkHeader } from '../spark/spark-header'
import { DownloadPicker } from './download-picker'
import { parseRelease } from './downloads'
import { useDownloadState } from './use-download-state'

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
  const view = render(<SiteHeader release={parseRelease(release)} />)
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
  container.innerHTML = renderToString(<SiteHeader release={parseRelease(release)} />)
  const link = container.querySelector('.spark-nav-cta')!
  expect(link.getAttribute('href')).toBe('/download/')
  expect(link.hasAttribute('target')).toBe(false)
  expect(request).not.toHaveBeenCalled()
})

test('a slow or failed refresh keeps the release supplied by the build', async () => {
  const pending = Promise.withResolvers<Response>()
  request.mockReturnValue(pending.promise)
  const report = spyOn(console, 'error').mockImplementation(() => {})
  const built = { version: 'v9.0.0', downloads: { 'mac-arm': 'https://example.test/current-build.dmg' } }
  try {
    const { container } = render(<SiteHeader release={built} />)
    const link = container.querySelector<HTMLAnchorElement>('.spark-nav-cta')!
    expect(link.href).toBe(built.downloads['mac-arm'])
    await act(async () => pending.reject(new Error('Offline')))
    expect(link.href).toBe(built.downloads['mac-arm'])
    expect(report).toHaveBeenCalledTimes(1)
  } finally {
    report.mockRestore()
  }
})

test('the header and hero share one refresh and always offer the same release', async () => {
  const pending = Promise.withResolvers<Response>()
  request.mockReturnValue(pending.promise)
  const built = { version: 'v9.0.0', downloads: { 'mac-arm': 'https://example.test/current-build.dmg' } }
  const Page = () => {
    const downloads = useDownloadState(built)
    return (
      <>
        <SparkHeader downloads={downloads} />
        <DownloadPicker {...downloads} />
      </>
    )
  }
  const { container } = render(<Page />)
  const header = container.querySelector<HTMLAnchorElement>('.spark-nav-cta')!
  const hero = container.querySelector<HTMLAnchorElement>('.download-primary-action a')!
  expect(header.href).toBe(built.downloads['mac-arm'])
  expect(header.href).toBe(hero.href)
  await act(async () => pending.resolve(Response.json(release)))
  expect(header.href).toBe(parseRelease(release).downloads['mac-arm']!)
  expect(header.href).toBe(hero.href)
  expect(request).toHaveBeenCalledTimes(1)
})
