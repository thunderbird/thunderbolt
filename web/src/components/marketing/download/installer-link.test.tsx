/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from 'bun:test'
import { act, type ComponentProps, type MouseEvent as ReactMouseEvent } from 'react'
import { render } from '../../../../test/render'
import { InstallerLink } from './installer-link'

const installerUrl = 'https://github.com/thunderbird/thunderbolt/releases/download/v1/Thunderbolt_1_aarch64.dmg'

let assign: ReturnType<typeof spyOn<Location, 'assign'>>
beforeEach(() => {
  jest.useFakeTimers()
  assign = spyOn(window.location, 'assign').mockImplementation(() => {})
})
afterEach(() => {
  assign.mockRestore()
  jest.useRealTimers()
})

const renderLink = (props: Partial<ComponentProps<typeof InstallerLink>> = {}) => {
  const { container } = render(
    <InstallerLink href={installerUrl} installerId="mac-arm" continueToDownloadPage {...props}>
      Download for macOS
    </InstallerLink>,
  )
  return container.querySelector('a')
}

const attributes = (link: HTMLAnchorElement | null) =>
  Object.fromEntries([...(link?.attributes ?? [])].map(({ name, value }) => [name, value]))

/** Click the link with the given button and modifier keys. */
const click = (link: HTMLAnchorElement | null, options: MouseEventInit = {}) => {
  // A plain Event reaches React's handler without Happy DOM following the link.
  const event = Object.assign(new Event('click', { bubbles: true, cancelable: true }), {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...options,
  })
  act(() => {
    link?.dispatchEvent(event)
  })
  return event
}

test('starts the download in a new tab and takes this one to the download page', () => {
  const link = renderLink({ className: 'spark-button', 'aria-label': 'Download Thunderbolt for macOS' })

  const event = click(link)

  expect(attributes(link)).toEqual({
    'aria-label': 'Download Thunderbolt for macOS',
    class: 'spark-button',
    href: installerUrl,
    rel: 'noopener',
    target: '_blank',
  })
  expect(event.defaultPrevented).toBe(false)
  // The browser must act on the link itself before this tab leaves the page.
  expect(assign).not.toHaveBeenCalled()
  jest.runAllTimers()
  expect(assign.mock.calls).toEqual([['/download/?installer=mac-arm']])
})

test('names the installer that was downloaded when it continues', () => {
  click(renderLink({ installerId: 'linux-deb' }))
  jest.runAllTimers()

  expect(assign.mock.calls).toEqual([['/download/?installer=linux-deb']])
})

test.each([
  ['with Command held', { metaKey: true }],
  ['with Control held', { ctrlKey: true }],
  ['with Shift held', { shiftKey: true }],
  ['with Alt held', { altKey: true }],
  ['of the middle button', { button: 1 }],
  ['of the secondary button', { button: 2 }],
])('leaves this tab where it is for a click %s', (_, options) => {
  const event = click(renderLink(), options)
  jest.runAllTimers()

  expect(event.defaultPrevented).toBe(false)
  expect(assign).not.toHaveBeenCalled()
})

test.each([
  ['leads somewhere other than an installer', { installerId: undefined }],
  ['is on a page that does not continue', { continueToDownloadPage: false }],
])('is an ordinary link when it %s', (_, props) => {
  const link = renderLink(props)

  click(link)
  jest.runAllTimers()

  expect(attributes(link)).toEqual({ href: installerUrl })
  expect(assign).not.toHaveBeenCalled()
})

test('runs a caller click handler and respects a canceled download', () => {
  const onClick = mock((event: ReactMouseEvent<HTMLAnchorElement>) => event.preventDefault())
  const event = click(renderLink({ onClick }))
  jest.runAllTimers()
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(event.defaultPrevented).toBe(true)
  expect(assign).not.toHaveBeenCalled()
})

test('honors cancellation from an ancestor capture handler', () => {
  const { container } = render(
    <div onClickCapture={(event) => event.preventDefault()}>
      <InstallerLink href={installerUrl} installerId="mac-arm" continueToDownloadPage>
        Download
      </InstallerLink>
    </div>,
  )
  click(container.querySelector('a'))
  jest.runAllTimers()
  expect(assign).not.toHaveBeenCalled()
})
