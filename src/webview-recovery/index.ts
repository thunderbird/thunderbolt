/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import { invoke } from '@tauri-apps/api/core'
import { activateLocale, getActiveLocale, i18n } from '@/i18n'
import { isTauriDesktop } from '@/lib/platform'
import { isRecord } from '@shared/lib/is-record'
import '@/index.css'
import './style.css'

// Keep this entry independent of React, the database, and the app's initialization graph.
const heading = document.querySelector<HTMLHeadingElement>('#heading')!
const explanation = document.querySelector<HTMLParagraphElement>('#explanation')!
const suggestion = document.querySelector<HTMLParagraphElement>('#suggestion')!
const retry = document.querySelector<HTMLButtonElement>('#retry')!
const error = document.querySelector<HTMLParagraphElement>('#error')!

/** Read only appearance preferences; a damaged settings record must not block recovery. */
const readState = (key: string): Record<string, unknown> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return isRecord(stored) && isRecord(stored.state) ? stored.state : {}
  } catch {
    return {}
  }
}

const chosenTheme = readState('thunderbolt-local-settings').theme
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')

/** Match the app's explicit appearance, or follow native/system appearance when unset. */
const applyTheme = () => {
  document.documentElement.classList.toggle(
    'dark',
    chosenTheme === 'dark' || (chosenTheme !== 'light' && systemTheme.matches),
  )
}

document.documentElement.classList.toggle('force-desktop', isTauriDesktop())
applyTheme()
systemTheme.addEventListener('change', applyTheme)

/** Render from the active catalog, including the synchronous English fallback. */
const render = () => {
  document.documentElement.lang = i18n.locale
  heading.textContent = i18n._(msg`Thunderbolt ran into a problem`)
  explanation.textContent = i18n._(
    msg`The app's web content stopped unexpectedly more than once. Automatic reloads have been paused.`,
  )
  suggestion.textContent = i18n._(
    msg`Try again, or install available system updates and reopen Thunderbolt if the problem continues.`,
  )
  retry.textContent = i18n._(msg`Try again`)
}

retry.addEventListener('click', async () => {
  retry.disabled = true
  error.textContent = ''
  try {
    await invoke('retry_webview_after_crash')
  } catch (cause) {
    console.error('Could not retry after the WebKit content process terminated', cause)
    error.textContent = i18n._(msg`Could not restart the app. Quit Thunderbolt and open it again.`)
    retry.disabled = false
  }
})

/** Locale loading must not prevent recovery controls from being available. */
const initialize = async () => {
  render()
  retry.disabled = false
  try {
    await activateLocale(getActiveLocale())
    render()
  } catch (cause) {
    console.error('Could not load the recovery page language', cause)
  }
}

void initialize()
