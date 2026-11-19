/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Synchronize Starlight's sidebar visibility, accessible button state, and focus boundary. */
export const initializeDocsMenu = (host: HTMLElement) => {
  const button = host.querySelector('button')!
  const navigation = host.closest('nav')!
  const desktop = window.matchMedia('(min-width: 50rem)')
  const content = document.querySelectorAll<HTMLElement>('.main-frame, .sl-skip-link')

  const setExpanded = (expanded: boolean) => {
    host.setAttribute('aria-expanded', String(expanded))
    button.setAttribute('aria-expanded', String(expanded))
    document.body.toggleAttribute('data-mobile-menu-expanded', expanded)
    content.forEach((element) => element.toggleAttribute('inert', expanded))
  }
  const close = () => setExpanded(false)
  const toggle = () => setExpanded(button.getAttribute('aria-expanded') !== 'true')
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || button.getAttribute('aria-expanded') !== 'true') return
    event.preventDefault()
    close()
    button.focus()
  }

  close()
  button.addEventListener('click', toggle)
  navigation.addEventListener('keydown', onKeyDown)
  desktop.addEventListener('change', close)

  return () => {
    button.removeEventListener('click', toggle)
    navigation.removeEventListener('keydown', onKeyDown)
    desktop.removeEventListener('change', close)
    close()
  }
}
