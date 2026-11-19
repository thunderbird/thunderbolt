/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AvailableModel } from './model-catalog'

/** Prefer catalog naming; otherwise humanize the untagged model ID, preserving versions and model-family casing. */
export const getModelDisplayName = ({ id, name }: Pick<AvailableModel, 'id' | 'name'>): string => {
  const displayName = name?.trim()
  if (displayName && displayName !== id) {
    return displayName
  }
  return (id.split('/').at(-1) || id)
    .split(':')[0]
    .split(/[-_\s]+/)
    .filter(Boolean)
    .flatMap((word) =>
      /^v\d/i.test(word) || /^[A-Za-z]\d$/.test(word) ? [word] : (word.match(/[A-Za-z]+|\d+(?:\.\d+)*/g) ?? [word]),
    )
    .map((word) => (/^v\d/i.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}
