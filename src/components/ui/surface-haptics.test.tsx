/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'

import { HapticsProvider } from '@/hooks/use-haptics'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { getClock, webHapticsTriggerMock } from '@/testing-library'
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from './alert-dialog'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { Drawer, DrawerContent, DrawerTitle } from './drawer'
import { Sheet, SheetContent, SheetTitle } from './sheet'

/** Renders a surface beneath the real haptics provider used by the app. */
const renderSurface = (surface: ReactNode) => render(<HapticsProvider>{surface}</HapticsProvider>)

beforeEach(() => {
  useLocalSettingsStore.setState({ hapticsEnabled: true })
})

describe('surface haptics', () => {
  it('mounts the boundary with an alert dialog portal', () => {
    renderSurface(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Confirm</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    )

    expect(webHapticsTriggerMock).toHaveBeenCalledWith('light')
  })

  it('mounts the boundary with a dialog portal', () => {
    renderSurface(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(webHapticsTriggerMock).toHaveBeenCalledWith('light')
  })

  it('responds when a drawer opens', () => {
    renderSurface(
      <Drawer open>
        <DrawerContent>
          <DrawerTitle>Actions</DrawerTitle>
        </DrawerContent>
      </Drawer>,
    )

    expect(webHapticsTriggerMock).toHaveBeenCalledWith('light')
  })

  it('fires drawer close feedback when closing starts', () => {
    const renderDrawer = (open: boolean) => (
      <Drawer open={open}>
        <DrawerContent>
          <DrawerTitle>Actions</DrawerTitle>
        </DrawerContent>
      </Drawer>
    )
    const view = renderSurface(renderDrawer(true))
    expect(webHapticsTriggerMock).toHaveBeenCalledTimes(1)

    act(() => getClock().tick(500))
    view.rerender(<HapticsProvider>{renderDrawer(false)}</HapticsProvider>)

    expect(webHapticsTriggerMock).toHaveBeenCalledTimes(2)
  })

  it('mounts the boundary with a sheet portal', () => {
    renderSurface(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Navigation</SheetTitle>
        </SheetContent>
      </Sheet>,
    )

    expect(webHapticsTriggerMock).toHaveBeenCalledWith('light')
  })
})
