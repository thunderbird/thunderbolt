/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
const previewCount = 5

/** Keep sidebar sections compact without hiding their current project or chat. */
export const useSidebarPreviewState = <T extends { id: string }>(items: T[], activeId?: string | null) => {
  const [visibleCount, setVisibleCount] = useState(previewCount)
  const hasOverflow = items.length > previewCount
  const showAll = visibleCount >= items.length
  const activeIndex = items.findIndex((item) => item.id === activeId)
  const preview =
    activeIndex >= visibleCount
      ? [...items.slice(0, visibleCount - 1), items[activeIndex]]
      : items.slice(0, visibleCount)

  return {
    items: preview,
    hasOverflow,
    showAll,
    toggle: () => setVisibleCount((previous) => (previous >= items.length ? previewCount : previous + previewCount)),
  }
}
