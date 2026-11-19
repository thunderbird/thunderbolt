/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useProductDemoState } from './use-product-demo-state'

const Harness = ({ source }: { source: string }) => {
  const { videoRef, isPlaying, hasPlayed, togglePlayback, onPlay, onPlaying, onPause, onError, onEmptied } =
    useProductDemoState(source)
  return (
    <>
      <video
        ref={videoRef}
        data-visible={hasPlayed}
        onPlay={onPlay}
        onPlaying={onPlaying}
        onPause={onPause}
        onError={onError}
        onEmptied={onEmptied}
      />
      <button onClick={togglePlayback}>{isPlaying ? 'Pause' : 'Play'}</button>
    </>
  )
}

let root: Root
let container: HTMLDivElement
let intersect: (ratio: number) => void
const media = Object.assign(new EventTarget(), { matches: false })
const originalObserver = globalThis.IntersectionObserver
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
let hidden = false
let disconnects = 0
let play: ReturnType<typeof spyOn<HTMLMediaElement, 'play'>>
let pause: ReturnType<typeof spyOn<HTMLMediaElement, 'pause'>>
let load: ReturnType<typeof spyOn<HTMLMediaElement, 'load'>>
let matchMedia: ReturnType<typeof spyOn<Window, 'matchMedia'>>

beforeEach(() => {
  media.matches = false
  hidden = false
  disconnects = 0
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  matchMedia = spyOn(window, 'matchMedia').mockReturnValue(media as MediaQueryList)
  // Keep play pending: browsers emit `play` before enough data exists for `playing`.
  play = spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  pause = spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'))
  })
  load = spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('emptied'))
  })
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback) {
      intersect = (ratio) =>
        callback(
          [{ isIntersecting: ratio > 0, intersectionRatio: ratio } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        )
    }
    observe() {}
    disconnect() {
      disconnects += 1
    }
  } as unknown as typeof IntersectionObserver
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Harness source="/light.mp4" />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  play.mockRestore()
  pause.mockRestore()
  load.mockRestore()
  matchMedia.mockRestore()
  globalThis.IntersectionObserver = originalObserver
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden)
  else Reflect.deleteProperty(document, 'hidden')
})

test('pending autoplay offers Pause, and clicking it pauses rather than contradicting the label', () => {
  act(() => intersect(0.5))
  expect(container.querySelector('button')!.textContent).toBe('Pause')
  expect(container.querySelector('video')!.dataset.visible).toBe('false')
  act(() => container.querySelector('button')!.click())
  expect(container.querySelector('button')!.textContent).toBe('Play')
  const calls = play.mock.calls.length
  act(() => intersect(0.6))
  expect(play.mock.calls.length).toBe(calls)
})

test('a manual pause survives a source/theme change', () => {
  act(() => intersect(0.5))
  act(() => container.querySelector('button')!.click())
  act(() => root.render(<Harness source="/dark.mp4" />))
  const calls = play.mock.calls.length
  act(() => intersect(0.5))
  expect(play.mock.calls.length).toBe(calls)
  expect(container.querySelector('button')!.textContent).toBe('Play')
  act(() => container.querySelector('button')!.click())
  expect(container.querySelector('video')!.getAttribute('src')).toBe('/dark.mp4')
})

test('a new theme shows its poster until the replacement footage actually plays', () => {
  act(() => intersect(0.5))
  act(() => container.querySelector('video')!.dispatchEvent(new Event('playing')))
  expect(container.querySelector('video')!.dataset.visible).toBe('true')
  act(() => root.render(<Harness source="/dark.mp4" />))
  expect(container.querySelector('video')!.dataset.visible).toBe('false')
  act(() => intersect(0.5))
  expect(container.querySelector('video')!.getAttribute('src')).toBe('/dark.mp4')
})

test('explicit Play overrides reduced-motion autoplay and the 15% threshold', () => {
  media.matches = true
  act(() => intersect(0.1))
  expect(play).not.toHaveBeenCalled()
  act(() => container.querySelector('button')!.click())
  const pauses = pause.mock.calls.length
  act(() => intersect(0.08))
  act(() => media.dispatchEvent(new Event('change')))
  expect(pause.mock.calls.length).toBe(pauses)
  expect(container.querySelector('button')!.textContent).toBe('Pause')
  act(() => intersect(0))
  expect(container.querySelector('button')!.textContent).toBe('Play')
  act(() => intersect(0.1))
  expect(container.querySelector('button')!.textContent).toBe('Pause')
})

test('automatic playback still respects reduced motion and viewport thresholds', () => {
  act(() => intersect(0.1))
  expect(play).not.toHaveBeenCalled()
  act(() => intersect(0.5))
  expect(play).toHaveBeenCalledTimes(1)
  media.matches = true
  act(() => media.dispatchEvent(new Event('change')))
  expect(container.querySelector('button')!.textContent).toBe('Play')
})

test('source changes show the new poster before asynchronous emptied events arrive', () => {
  act(() => intersect(0.5))
  act(() => container.querySelector('video')!.dispatchEvent(new Event('playing')))
  load.mockImplementation(() => {})
  pause.mockImplementation(() => {})
  act(() => root.render(<Harness source="/dark.mp4" />))
  expect(container.querySelector('video')!.dataset.visible).toBe('false')
  expect(container.querySelector('button')!.textContent).toBe('Play')
})

test('a blocked autoplay keeps the poster and can be retried with an explicit click', async () => {
  play.mockImplementationOnce(() => Promise.reject(new DOMException('Blocked autoplay', 'NotAllowedError')))
  await act(async () => intersect(0.5))
  expect(container.querySelector('button')!.textContent).toBe('Play')
  expect(container.querySelector('video')!.dataset.visible).toBe('false')
  act(() => container.querySelector('button')!.click())
  expect(container.querySelector('button')!.textContent).toBe('Pause')
})

test('media failure restores the poster and releases the failed source so Play can retry it', () => {
  act(() => intersect(0.5))
  act(() => container.querySelector('video')!.dispatchEvent(new Event('playing')))
  act(() => container.querySelector('video')!.dispatchEvent(new Event('error')))
  const video = container.querySelector('video')!
  expect(video.hasAttribute('src')).toBe(false)
  expect(video.dataset.visible).toBe('false')
  expect(container.querySelector('button')!.textContent).toBe('Play')
  act(() => container.querySelector('button')!.click())
  expect(video.getAttribute('src')).toBe('/light.mp4')
  expect(container.querySelector('button')!.textContent).toBe('Pause')
})

test('pausing a visible frame keeps it visible instead of restoring the poster', () => {
  act(() => intersect(0.5))
  act(() => container.querySelector('video')!.dispatchEvent(new Event('playing')))
  act(() => container.querySelector('button')!.click())
  expect(container.querySelector('video')!.dataset.visible).toBe('true')
  expect(container.querySelector('button')!.textContent).toBe('Play')
})

test('background tabs pause and resume automatic playback without forgetting a manual pause', () => {
  act(() => intersect(0.5))
  hidden = true
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(container.querySelector('button')!.textContent).toBe('Play')
  hidden = false
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(container.querySelector('button')!.textContent).toBe('Pause')
  act(() => container.querySelector('button')!.click())
  const calls = play.mock.calls.length
  hidden = true
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  hidden = false
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(play.mock.calls.length).toBe(calls)
})

test('explicit playback also stops in a background tab and resumes on return', () => {
  media.matches = true
  act(() => intersect(0.5))
  act(() => container.querySelector('button')!.click())
  hidden = true
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(container.querySelector('button')!.textContent).toBe('Play')
  hidden = false
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(container.querySelector('button')!.textContent).toBe('Pause')
})

test('source changes disconnect the old observer and detach its playback listeners', () => {
  act(() => intersect(0.5))
  act(() => root.render(<Harness source="/dark.mp4" />))
  expect(disconnects).toBe(1)
  act(() => intersect(0.5))
  const calls = play.mock.calls.length
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(play.mock.calls.length).toBe(calls + 1)
})

test('an unmounted demo releases its source and no longer responds to visibility or motion', () => {
  act(() => intersect(0.5))
  const video = container.querySelector('video')!
  act(() => root.render(null))
  expect(disconnects).toBe(1)
  expect(video.hasAttribute('src')).toBe(false)
  const calls = play.mock.calls.length
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  act(() => media.dispatchEvent(new Event('change')))
  expect(play.mock.calls.length).toBe(calls)
})

test('resuming after an automatic offscreen pause honors an explicit Pause on the resumed video', () => {
  act(() => intersect(0.5))
  act(() => intersect(0))
  expect(container.querySelector('button')!.textContent).toBe('Play')
  act(() => intersect(0.5))
  act(() => container.querySelector('button')!.click())
  const calls = play.mock.calls.length
  act(() => intersect(0))
  act(() => intersect(0.5))
  expect(play.mock.calls.length).toBe(calls)
})
