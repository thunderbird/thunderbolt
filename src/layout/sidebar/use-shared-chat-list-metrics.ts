/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type RefObject } from 'react'

/** Keep virtual chat offsets aligned when the project folders above them change height. */
export const useSharedChatListMetrics = (scrollRef?: RefObject<HTMLDivElement | null>) => {
  const listRef = useRef<HTMLDivElement>(null)
  const [startMargin, setStartMargin] = useState(0)

  // The scroll ref belongs to an ancestor; its ref is attached after child layout effects.
  useEffect(() => {
    if (!scrollRef) {
      return
    }
    const scroll = scrollRef.current!
    const list = listRef.current!
    const measure = () =>
      setStartMargin(list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop)
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    observer.observe(scroll.firstElementChild!)
    measure()
    return () => observer.disconnect()
  }, [scrollRef])

  return { listRef, startMargin }
}
