/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { mobilePage, measureMobilePage } from './adapters/mobile-page'
import { pageController } from './page-controller'
import { waitForPagePresentation } from './page-presentation'
import { openUrlPage, usePageStore, type PageSession } from './page-store'

const capabilities = {
  observe: true,
  selectElement: true,
  navigate: true,
  declaredTools: false,
  screenshot: false,
  pointerInput: 'none',
  keyboardInput: 'none',
} as const

/** Own one mobile webview for a session, independent of its inline/sidebar/expanded placement. */
export const MobilePageHost = ({ session, visible }: { session: PageSession; visible: boolean }) => {
  const viewport = useRef<HTMLDivElement>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const updatePresentation = useRef<(() => void) | null>(null)
  const source = session.page.source
  const initialUrl = source.kind === 'url' ? source.url : null

  useEffect(() => {
    if (!initialUrl || !viewport.current) {
      usePageStore.getState().update(session.id, { error: 'Local apps are available on their owning desktop device.' })
      return
    }
    const element = viewport.current
    const label = `page-${crypto.randomUUID()}`
    let active = true
    let created = false
    let revision = 0
    let blank = initialUrl === 'about:blank'
    let frame: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let unregister: (() => void) | undefined
    let unlisten: (() => void) | undefined
    let presentation = Promise.resolve()
    const report = (error: unknown) => {
      if (active) {
        usePageStore.getState().update(session.id, { error: String(error) })
      }
    }
    const present = (strict = false): Promise<void> => {
      if (!active || !created) {
        return strict ? Promise.reject(new Error('Mobile page is not ready')) : Promise.resolve()
      }
      const pending = presentation.then(async () => {
        if (!active) {
          return
        }
        const bounds = measureMobilePage(element)
        const clip = bounds.clip
        const drawable = !clip || (clip.left + clip.right < bounds.width && clip.top + clip.bottom < bounds.height)
        await mobilePage.present(label, bounds, visibleRef.current && !blank && drawable)
      })
      presentation = pending.catch(report)
      return strict ? pending : presentation
    }
    const schedule = () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => {
        frame = undefined
        present()
      })
    }
    updatePresentation.current = schedule
    const refresh = async () => {
      const requestedRevision = ++revision
      const { error, ...browser } = await mobilePage.state(label)
      if (!active || requestedRevision !== revision) {
        return
      }
      const wasBlank = blank
      blank = browser.url === 'about:blank'
      usePageStore.getState().update(session.id, { browser, error: error ?? null })
      if (wasBlank !== blank) {
        present()
      }
    }
    const poll = async () => {
      try {
        await refresh()
      } catch (error) {
        report(error)
      }
      if (active) {
        timer = setTimeout(poll, visibleRef.current ? 500 : 1500)
      }
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    const mutation = new MutationObserver(schedule)
    const host = element.closest<HTMLElement>('[data-page-host]')
    if (host) {
      mutation.observe(host, { attributes: true, attributeFilter: ['style'] })
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)

    const initialize = async () => {
      try {
        const availability = await mobilePage.capabilities()
        if (!active) {
          return
        }
        if (!availability.available) {
          throw new Error('Update Android System WebView to open pages with isolated storage.')
        }
        const off = await listen<{ label: string; url: string }>('browser-new-tab', (event) => {
          if (active && event.payload.label === label) {
            openUrlPage(event.payload.url)
          }
        })
        if (!active) {
          off()
          return
        }
        unlisten = off
        await mobilePage.create(label, initialUrl, measureMobilePage(element), true)
        created = true
        if (!active) {
          await mobilePage.close(label)
          return
        }
        unregister = pageController.register(session.id, {
          capabilities,
          present: async (signal) => {
            await waitForPagePresentation(session.id, signal)
            signal?.throwIfAborted()
            await present(true)
          },
          snapshot: async (screenshot, signal) => {
            signal?.throwIfAborted()
            if (screenshot) {
              throw new Error('Screenshots are unavailable for mobile pages.')
            }
            const result = await mobilePage.snapshot(label)
            signal?.throwIfAborted()
            return result
          },
          navigate: async (navigation) => {
            revision += 1
            if (navigation.type === 'navigate') {
              await mobilePage.navigate(label, navigation.url)
            } else {
              await mobilePage.action(label, navigation.type)
            }
            await refresh()
          },
          picker: (enabled, requestId) => mobilePage.setPicker(label, enabled, requestId),
          pollPicker: (requestId) => mobilePage.pollPicker(label, requestId),
        })
        present()
        await poll()
      } catch (error) {
        report(error)
      }
    }
    void initialize()
    return () => {
      active = false
      unregister?.()
      unlisten?.()
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
      clearTimeout(timer)
      resize.disconnect()
      mutation.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
      updatePresentation.current = null
      if (created) {
        void mobilePage.close(label).catch(console.error)
      }
    }
  }, [session.id, initialUrl])

  useEffect(() => {
    updatePresentation.current?.()
  }, [visible])
  return <div ref={viewport} className="h-full w-full" />
}
