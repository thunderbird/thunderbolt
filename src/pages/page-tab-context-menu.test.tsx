/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Menu } from '@tauri-apps/api/menu'
import { Pin, X } from 'lucide-react'
import { PageTabContextMenu } from './page-tab-context-menu'

afterEach(cleanup)
const setup = (native: boolean) => {
  const pin = mock(() => {})
  const close = mock(() => {})
  return {
    pin,
    close,
    ...render(
      <PageTabContextMenu
        native={native}
        items={[
          { id: 'pin', label: 'Pin', icon: Pin, disabled: true, onSelect: pin },
          'separator',
          { id: 'close', label: 'Close tab', icon: X, onSelect: close },
        ]}
        onCloseAutoFocus={undefined}
      >
        <button>Page tab</button>
      </PageTabContextMenu>,
    ),
  }
}

it('uses the same enabled actions in a DOM menu on web and for HTML pages', () => {
  const { close, pin } = setup(false)
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Page tab' }))
  expect(screen.getByRole('menuitem', { name: 'Pin' })).toHaveAttribute('data-disabled')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pin' }))
  expect(pin).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Close tab' }))
  expect(close).toHaveBeenCalledTimes(1)
})

it('opens a native menu without a modal DOM overlay and releases previous menus and the unmounted tab', async () => {
  const popup = mock(async () => {})
  const release = mock(async () => {})
  const create = spyOn(Menu, 'new').mockResolvedValue({ popup, close: release } as unknown as Menu)
  try {
    const { close, container, unmount } = setup(true)
    await act(async () => fireEvent.contextMenu(screen.getByRole('button'), { clientX: 120, clientY: 50 }))
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ x: 120, y: 50 }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(container.getAttribute('aria-hidden')).toBeNull()
    const items = create.mock.calls[0][0]!.items!
    expect(items[0]).toMatchObject({ text: 'Pin', enabled: false })
    expect(items[1]).toEqual({ item: 'Separator' })
    const closeItem = items[2]
    expect(closeItem).toMatchObject({ text: 'Close tab', enabled: true })
    if ('action' in closeItem) {
      closeItem.action?.('native-id')
    }
    expect(close).toHaveBeenCalledTimes(1)
    await act(async () => fireEvent.contextMenu(screen.getByRole('button')))
    expect(release).toHaveBeenCalledTimes(1)
    await act(async () => unmount())
    expect(release).toHaveBeenCalledTimes(2)
  } finally {
    create.mockRestore()
  }
})

it('releases a menu without showing it if its tab closes during native creation', async () => {
  const deferred = Promise.withResolvers<Menu>()
  const popup = mock(async () => {})
  const release = mock(async () => {})
  const create = spyOn(Menu, 'new').mockReturnValue(deferred.promise)
  try {
    const { unmount } = setup(true)
    fireEvent.contextMenu(screen.getByRole('button'))
    unmount()
    await act(async () => deferred.resolve({ popup, close: release } as unknown as Menu))
    expect(popup).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  } finally {
    create.mockRestore()
  }
})
