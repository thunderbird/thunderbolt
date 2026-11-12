/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { SlideInPanel } from './slide-in-panel'

afterEach(() => {
  cleanup()
  mock.restore()
})

const entrance = 'animate-[slide-in-panel-open_300ms]'
const finishTransition = (element: Element, propertyName: string) =>
  fireEvent(element, Object.assign(new Event('transitionend', { bubbles: true }), { propertyName }))

describe('SlideInPanel motion lifecycle', () => {
  it('uses one width transition for a mounted panel, without hiding content behind a second translation', () => {
    const { container, rerender } = render(
      <SlideInPanel open={false} width="480px">
        Body
      </SlideInPanel>,
    )
    const surface = container.querySelector('aside')!
    expect(surface.style.width).toBe('0px')
    expect(surface).not.toHaveClass(entrance)
    rerender(
      <SlideInPanel open width="480px">
        Body
      </SlideInPanel>,
    )
    expect(container.querySelector('aside')).toBe(surface)
    expect(surface.style.width).toBe('480px')
    expect(surface).not.toHaveClass(entrance)
    expect((surface.firstElementChild as HTMLElement).style.transform).toBe('')
    expect(surface).not.toHaveAttribute('inert')
  })

  it('animates a lazy panel that first mounts open, then retires its mount animation', () => {
    const { container } = render(
      <SlideInPanel open width="480px">
        Body
      </SlideInPanel>,
    )
    const surface = container.querySelector('aside')!
    expect(surface).toHaveClass(entrance, 'motion-reduce:animate-none')
    expect(surface.style.getPropertyValue('--slide-panel-width')).toBe('480px')
    fireEvent.animationEnd(surface.firstElementChild!, { animationName: 'some-child-animation' })
    expect(surface).toHaveClass(entrance)
    fireEvent.animationEnd(surface, { animationName: 'slide-in-panel-open' })
    expect(container.querySelector('aside')).toBe(surface)
    expect(surface).not.toHaveClass(entrance)
    expect(surface.style.width).toBe('480px')
  })

  it('removes an interrupted entrance so closing can finish, and reopening uses the existing surface', () => {
    const closed = mock(() => {})
    const { container, rerender } = render(
      <SlideInPanel open width="480px" onCloseComplete={closed}>
        Body
      </SlideInPanel>,
    )
    const surface = container.querySelector('aside')!
    rerender(
      <SlideInPanel open={false} width="480px" onCloseComplete={closed}>
        Body
      </SlideInPanel>,
    )
    expect(surface).not.toHaveClass(entrance)
    expect(surface.style.width).toBe('0px')
    expect(surface).toHaveAttribute('inert')
    finishTransition(surface.firstElementChild!, 'width')
    finishTransition(surface, 'opacity')
    expect(closed).not.toHaveBeenCalled()
    finishTransition(surface, 'width')
    expect(closed).toHaveBeenCalledTimes(1)
    rerender(
      <SlideInPanel open width="480px" onCloseComplete={closed}>
        Body
      </SlideInPanel>,
    )
    expect(container.querySelector('aside')).toBe(surface)
    expect(surface).not.toHaveClass(entrance)
  })

  it('finishes closing without waiting for transition events under reduced motion', () => {
    const matchMedia = window.matchMedia.bind(window)
    spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        new Proxy(matchMedia(query), {
          get: (target, key) => (key === 'matches' ? true : Reflect.get(target, key, target)),
        }),
    )
    const closed = mock(() => {})
    const { rerender } = render(
      <SlideInPanel open width="480px" onCloseComplete={closed}>
        Body
      </SlideInPanel>,
    )
    rerender(
      <SlideInPanel open={false} width="480px" onCloseComplete={closed}>
        Body
      </SlideInPanel>,
    )
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
