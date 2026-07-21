/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DocsContainer, type DocsContainerProps } from '@storybook/addon-docs/blocks'
import { GLOBALS_UPDATED } from 'storybook/internal/core-events'
import type { GlobalsUpdatedPayload } from 'storybook/internal/types'
import { themes } from 'storybook/theming'
import { useEffect, useState, type PropsWithChildren } from 'react'

declare global {
  /** Base URL addon-docs uses to build `inline: false` story iframe srcs. */
  var PREVIEW_URL: string | undefined
}

/**
 * Subscribe to the `theme` toolbar global from within the docs renderer.
 * Storybook also re-renders the whole docs page on globals updates, but that
 * re-render can die mid-commit on a long-standing Storybook bug (instrumented
 * focus() throwing "Could not determine window of node" for detached nodes,
 * reproducible with the stock DocsContainer). Owning the theme in local state
 * lets our commit apply the new theme first, so the page is already correct
 * if Storybook's follow-up re-render crashes.
 */
const useThemeGlobal = (context: DocsContainerProps['context']): 'light' | 'dark' => {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    context.getStoryContext(context.storyById()).globals.theme === 'dark' ? 'dark' : 'light',
  )

  useEffect(() => {
    const onGlobalsUpdated = ({ globals }: GlobalsUpdatedPayload) =>
      setTheme(globals.theme === 'dark' ? 'dark' : 'light')
    context.channel.on(GLOBALS_UPDATED, onGlobalsUpdated)
    return () => context.channel.off(GLOBALS_UPDATED, onGlobalsUpdated)
  }, [context])

  return theme
}

/**
 * Docs container that follows the theme toolbar toggle. Docs pages need three
 * things the canvas view gets for free from the withThemeByClassName
 * decorator:
 *
 * 1. Storybook's docs chrome (headings, args tables, code blocks) is styled by
 *    an emotion theme, not app CSS — pass the matching sb theme.
 * 2. The `dark` class on the docs iframe's <html>, so app CSS variables and
 *    inline-rendered stories flip.
 * 3. `inline: false` stories render in nested iframes that are fully isolated
 *    previews — the manager's channel never reaches them, so they only pick up
 *    globals from their own URL at boot. addon-docs builds those srcs from
 *    PREVIEW_URL, so bake the theme in for the initial load; on toggle the
 *    iframes never reload (their src is fixed on mount), so sync the `dark`
 *    class into their documents directly.
 */
export const ThemedDocsContainer = ({ context, children }: PropsWithChildren<DocsContainerProps>) => {
  const theme = useThemeGlobal(context)

  globalThis.PREVIEW_URL = `iframe.html?globals=theme:${theme}`

  useEffect(() => {
    const dark = theme === 'dark'
    document.documentElement.classList.toggle('dark', dark)

    // `inline: false` story iframes never reload after mount (their src is
    // fixed), so push the theme class into their documents directly. The load
    // listener re-applies it for frames that finish booting after a toggle.
    const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('.docs-story iframe'))
    const applyToFrame = (frame: HTMLIFrameElement) =>
      frame.contentDocument?.documentElement.classList.toggle('dark', dark)
    const unsubscribes = frames.map((frame) => {
      const onLoad = () => applyToFrame(frame)
      applyToFrame(frame)
      frame.addEventListener('load', onLoad)
      return () => frame.removeEventListener('load', onLoad)
    })
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [theme])

  return (
    <DocsContainer context={context} theme={theme === 'dark' ? themes.dark : themes.light}>
      {children}
    </DocsContainer>
  )
}
