/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where a click on an external link in chat goes (THU-788).
 * `sidebar` renders the page in the in-app side panel and is desktop-only;
 * `browser` skips the confirmation and opens the OS browser / a new tab.
 */
export type ExternalLinkBehavior = 'ask' | 'sidebar' | 'browser'

export const externalLinkBehaviors: readonly ExternalLinkBehavior[] = ['ask', 'sidebar', 'browser']

export const isExternalLinkBehavior = (value: string): value is ExternalLinkBehavior =>
  (externalLinkBehaviors as readonly string[]).includes(value)

/** What a link click should actually do, once the preference is reconciled with what the platform supports. */
export type ExternalLinkAction = 'browser' | 'sidebar' | 'dialog'

/**
 * Resolves the preference into a concrete action.
 *
 * `sidebar` needs the in-app side panel, so it degrades to the confirmation
 * dialog wherever the panel is unavailable rather than dead-ending the click.
 * `browser` intentionally ignores `isSafe` — the opener validates the URL and
 * surfaces the dialog with an error, which is a better UX than silently doing nothing.
 */
export const resolveLinkAction = (
  behavior: ExternalLinkBehavior,
  { canUseSidebar, isSafe }: { canUseSidebar: boolean; isSafe: boolean },
): ExternalLinkAction => {
  if (behavior === 'browser') {
    return 'browser'
  }
  if (behavior === 'sidebar' && canUseSidebar && isSafe) {
    return 'sidebar'
  }
  return 'dialog'
}
