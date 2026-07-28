/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'bun:test'
import { useState } from 'react'

import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { getClock, webHapticsTriggerMock } from '@/testing-library'
import { HapticMountBoundary, HapticsProvider, useHaptics } from './use-haptics'

const SurfaceAfterInteraction = () => {
  const [open, setOpen] = useState(false)
  const { triggerSelection } = useHaptics()
  return (
    <>
      <button
        type="button"
        onClick={() => {
          triggerSelection()
          setOpen(true)
        }}
      >
        Open
      </button>
      {open && <HapticMountBoundary />}
    </>
  )
}

beforeEach(() => {
  useLocalSettingsStore.setState({ hapticsEnabled: true })
})

describe('HapticMountBoundary', () => {
  it('requests surface feedback when its portal boundary mounts and unmounts', () => {
    const { unmount } = render(
      <HapticsProvider>
        <HapticMountBoundary />
      </HapticsProvider>,
    )

    expect(webHapticsTriggerMock).toHaveBeenCalledWith('light')

    act(() => getClock().tick(500))
    unmount()

    expect(webHapticsTriggerMock).toHaveBeenCalledTimes(2)
  })

  it('does not duplicate the interaction feedback that opened a surface', () => {
    render(
      <HapticsProvider>
        <SurfaceAfterInteraction />
      </HapticsProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    expect(webHapticsTriggerMock).toHaveBeenCalledTimes(1)
    expect(webHapticsTriggerMock).toHaveBeenCalledWith('selection')
  })
})
