/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { ChatAddMenu } from './chat-add-menu'

afterEach(() => {
  cleanup()
  restoreViewport()
})

describe('ChatAddMenu', () => {
  it('opens file and connection actions in a mobile bottom drawer', () => {
    forceMobileViewport()
    const onUploadFile = mock(() => {})
    const onOpenConnections = mock(() => {})
    render(<ChatAddMenu onUploadFile={onUploadFile} onOpenConnections={onOpenConnections} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))

    const drawer = screen
      .getByText('Add to chat', { selector: '[data-slot="drawer-title"]' })
      .closest('[data-slot="drawer-content"]')
    expect(drawer).toHaveAttribute('data-swipe-direction', 'down')

    fireEvent.click(screen.getByRole('button', { name: 'Upload file' }))
    expect(onUploadFile).toHaveBeenCalledTimes(1)
  })

  it('keeps the compact anchored menu on desktop', () => {
    render(<ChatAddMenu onUploadFile={() => {}} onOpenConnections={() => {}} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add to chat' }), { button: 0, ctrlKey: false })

    expect(screen.getByRole('menuitem', { name: 'Connections' })).toBeInTheDocument()
  })
})
