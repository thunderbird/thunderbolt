/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { ChatAddMenu } from './chat-add-menu'

const setMobileViewport = (matches: boolean) => {
  window.matchMedia = () => ({
    matches,
    media: '(max-width: 767px)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })
}

afterEach(cleanup)

describe('ChatAddMenu', () => {
  it('opens file and connection actions in a mobile bottom drawer', () => {
    setMobileViewport(true)
    const onUploadFile = mock(() => {})
    const onOpenConnections = mock(() => {})
    render(<ChatAddMenu onUploadFile={onUploadFile} onOpenConnections={onOpenConnections} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))

    const drawer = screen
      .getByText('Add to chat', { selector: '[data-slot="drawer-title"]' })
      .closest('[data-slot="drawer-content"]')
    expect(drawer).toHaveAttribute('data-vaul-drawer-direction', 'bottom')

    fireEvent.click(screen.getByRole('button', { name: 'Upload file' }))
    expect(onUploadFile).toHaveBeenCalledTimes(1)
  })

  it('keeps the compact anchored menu on desktop', () => {
    setMobileViewport(false)
    render(<ChatAddMenu onUploadFile={() => {}} onOpenConnections={() => {}} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add to chat' }), { button: 0, ctrlKey: false })

    expect(screen.getByRole('menuitem', { name: 'Connections' })).toBeInTheDocument()
  })
})
