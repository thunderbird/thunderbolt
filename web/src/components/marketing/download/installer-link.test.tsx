/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { act, type ComponentProps, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { InstallerLink } from './installer-link'

let container: HTMLDivElement
let root: Root
let assign: ReturnType<typeof spyOn<Location, 'assign'>>
let schedule: ReturnType<typeof spyOn<Window, 'setTimeout'>>
const installerUrl = 'https://github.com/thunderbird/thunderbolt/releases/download/v1/Thunderbolt_1_aarch64.dmg'

const render = (props: ComponentProps<typeof InstallerLink> = {}) => {
  act(() =>
    root.render(
      <InstallerLink href={installerUrl} installerId="mac-arm" continueToDownloadPage {...props}>
        Download for macOS
      </InstallerLink>,
    ),
  )
  schedule.mockClear()
  return container.querySelector('a')!
}

const click = (link: HTMLAnchorElement, options: MouseEventInit = {}) => {
  // Dispatch React's handler without Happy DOM executing a real network navigation.
  const event = Object.assign(new Event('click', { bubbles: true, cancelable: true }), {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...options,
  })
  act(() => link.dispatchEvent(event))
  return event
}

beforeEach(() => {
  assign = spyOn(window.location, 'assign').mockImplementation(() => {})
  schedule = spyOn(window, 'setTimeout')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  assign.mockRestore()
  schedule.mockRestore()
})

test('keeps the real installer link and isolates its native download from the page navigation', async () => {
  const link = render({ className: 'spark-button', 'aria-label': 'Download Thunderbolt for macOS' })
  expect(link.getAttribute('href')).toBe(installerUrl)
  expect(link.target).toBe('_blank')
  expect(link.rel).toBe('noopener')
  expect(link.className).toBe('spark-button')
  expect(link.getAttribute('aria-label')).toBe('Download Thunderbolt for macOS')
  expect(link.hasAttribute('download')).toBe(false)

  const event = click(link)
  expect(event.defaultPrevented).toBe(false)
  expect(schedule).toHaveBeenCalledWith(expect.any(Function), 0)
  expect(assign).not.toHaveBeenCalled()

  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(assign).toHaveBeenCalledTimes(1)
  expect(assign).toHaveBeenCalledWith('/download/?installer=mac-arm')
})

test.each([
  ['Command', { metaKey: true }],
  ['Control', { ctrlKey: true }],
  ['Shift', { shiftKey: true }],
  ['Alt', { altKey: true }],
  ['middle button', { button: 1 }],
  ['secondary button', { button: 2 }],
] as const)('%s clicks keep native link behavior without redirecting the current page', (_name, options) => {
  const event = click(render(), options)
  expect(event.defaultPrevented).toBe(false)
  expect(schedule).not.toHaveBeenCalled()
  expect(assign).not.toHaveBeenCalled()
})

test('runs the caller handler first and honors its cancellation', () => {
  const onClick = mock((event: ReactMouseEvent<HTMLAnchorElement>) => {
    expect(schedule).not.toHaveBeenCalled()
    event.preventDefault()
  })
  const event = click(render({ onClick }))
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(event.defaultPrevented).toBe(true)
  expect(schedule).not.toHaveBeenCalled()
  expect(assign).not.toHaveBeenCalled()
})

test('honors a click that was already canceled', () => {
  const link = render()
  const event = Object.assign(new Event('click', { bubbles: true, cancelable: true }), { button: 0 })
  event.preventDefault()
  act(() => link.dispatchEvent(event))
  expect(schedule).not.toHaveBeenCalled()
  expect(assign).not.toHaveBeenCalled()
})

test('keyboard activation continues to the page for the selected installer', async () => {
  const onClick = mock(() => expect(schedule).not.toHaveBeenCalled())
  click(render({ installerId: 'linux-deb', onClick }), { detail: 0 })
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(assign).not.toHaveBeenCalled()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(assign).toHaveBeenCalledWith('/download/?installer=linux-deb')
})

test.each([
  ['fallback', { installerId: undefined }],
  ['retry', { continueToDownloadPage: false }],
  ['default', { continueToDownloadPage: undefined }],
] as const)('%s links retain ordinary anchor behavior', (_name, props) => {
  const onClick = mock(() => {})
  const link = render({ ...props, onClick, target: '_self', rel: 'external' })
  expect(link.getAttribute('href')).toBe(installerUrl)
  expect(link.target).toBe('_self')
  expect(link.rel).toBe('external')
  const event = click(link)
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(event.defaultPrevented).toBe(false)
  expect(schedule).not.toHaveBeenCalled()
  expect(assign).not.toHaveBeenCalled()
})
