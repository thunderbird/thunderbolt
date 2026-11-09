/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { MapWidget } from './widget'

const data = JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-122.3321, 47.6062] }, properties: {} }],
})
const unavailableMessage = 'Maps can’t be displayed here — WebGL is disabled or unavailable in this browser.'

describe('MapWidget visibility', () => {
  let originalObserver: typeof IntersectionObserver
  let callback: IntersectionObserverCallback
  const disconnect = mock()
  let getContext: ReturnType<typeof spyOn<HTMLCanvasElement, 'getContext'>>

  beforeEach(() => {
    originalObserver = globalThis.IntersectionObserver
    globalThis.IntersectionObserver = class {
      constructor(onIntersect: IntersectionObserverCallback) {
        callback = onIntersect
      }
      observe() {}
      disconnect = disconnect
    } as unknown as typeof IntersectionObserver
    getContext = spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  afterEach(() => {
    cleanup()
    globalThis.IntersectionObserver = originalObserver
    getContext.mockRestore()
    disconnect.mockClear()
  })

  const reportVisibility = (isIntersecting: boolean) =>
    act(() => callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver))

  it('keeps an offscreen map placeholder without probing WebGL', () => {
    const { container } = render(<MapWidget data={data} title="Office locations" />)
    expect(screen.getByText('Office locations')).toBeVisible()
    expect(screen.queryByText(unavailableMessage)).not.toBeInTheDocument()
    expect(getContext).not.toHaveBeenCalled()
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('probes once near the viewport and preserves unsupported-browser feedback when scrolled away', () => {
    const { rerender, unmount } = render(<MapWidget data={data} title="Office locations" />)
    reportVisibility(true)
    expect(getContext).toHaveBeenCalledTimes(1)
    expect(getContext).toHaveBeenCalledWith('webgl2')
    expect(screen.getByText(unavailableMessage)).toBeVisible()
    expect(disconnect).toHaveBeenCalledTimes(1)

    reportVisibility(false)
    rerender(<MapWidget data={data} title="Updated title" />)
    expect(screen.getByText('Updated title')).toBeVisible()
    expect(screen.getByText(unavailableMessage)).toBeVisible()
    expect(getContext).toHaveBeenCalledTimes(1)
    unmount()
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('keeps invalid data hidden and recovers when valid data arrives', () => {
    const { container, rerender } = render(<MapWidget data="invalid" />)
    expect(container).toBeEmptyDOMElement()
    expect(getContext).not.toHaveBeenCalled()
    rerender(<MapWidget data={data} title="Recovered map" />)
    expect(screen.getByText('Recovered map')).toBeVisible()
    expect(screen.getByText(unavailableMessage)).toBeVisible()
  })

  it('shows the same fallback if the browser throws while creating a WebGL context', () => {
    getContext.mockImplementation(() => {
      throw new Error('WebGL context creation blocked')
    })
    render(<MapWidget data={data} />)
    reportVisibility(true)
    expect(screen.getByText(unavailableMessage)).toBeVisible()
  })

  it('still activates when IntersectionObserver is unavailable', () => {
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver
    render(<MapWidget data={data} />)
    expect(getContext).toHaveBeenCalledTimes(1)
    expect(screen.getByText(unavailableMessage)).toBeVisible()
  })
})
