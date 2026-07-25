/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'

import { getClock } from '@/testing-library'
import { Drawer, DrawerContent, DrawerTitle } from './drawer'
import { Input } from './input'
import { MobileActionSheet, MobileActionSheetFooter } from './mobile-action-sheet'

describe('MobileActionSheet', () => {
  it('renders an accessible, keyboard-aware bottom sheet', () => {
    render(
      <MobileActionSheet
        open
        onOpenChange={() => {}}
        title="Delete this chat?"
        description="This will permanently delete this chat."
        role="alertdialog"
      >
        <Input aria-label="Chat name" />
        <MobileActionSheetFooter>
          <button type="button">Cancel</button>
          <button type="button">Delete Chat</button>
        </MobileActionSheetFooter>
      </MobileActionSheet>,
    )

    const sheet = screen.getByRole('alertdialog', { name: 'Delete this chat?' })
    expect(sheet).toHaveAttribute('data-swipe-direction', 'down')
    expect(sheet).toHaveClass('data-[swipe-direction=down]:bottom-[var(--drawer-keyboard-inset,var(--kb,0px))]')
    expect(sheet).toHaveClass('[&_[data-slot=input]]:!bg-card', 'dark:[&_[data-slot=input]]:!bg-input')
    expect(screen.getByText('This will permanently delete this chat.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' }).parentElement).toHaveClass('flex-col-reverse')

    act(() => screen.getByRole('textbox', { name: 'Chat name' }).focus())
    act(() => getClock().runAll())
    const viewport = document.querySelector<HTMLElement>('[data-slot="drawer-viewport"]')
    expect(viewport?.style.getPropertyValue('--drawer-keyboard-inset')).toBe('0px')
  })

  it('keeps its blurred backdrop when nested inside another drawer', () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerTitle>Navigation</DrawerTitle>
          <MobileActionSheet open onOpenChange={() => {}} title="Rename chat">
            <input aria-label="Chat name" />
          </MobileActionSheet>
        </DrawerContent>
      </Drawer>,
    )

    const backdrops = document.querySelectorAll('[data-slot="drawer-overlay"]')
    expect(backdrops).toHaveLength(2)
    expect(backdrops[1]).toHaveClass('bg-black/30', 'backdrop-blur-xs')
  })
})
