/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProjectArtifact } from './project-artifacts-data'

export const artifactGridGap = 16
const artifactCardMinWidth = 260
const maxVisibleRows = 3

/** Match the gallery's minimum card width, including the space between columns. */
export const artifactGridColumns = (width: number) =>
  Math.max(1, Math.floor((width + artifactGridGap) / (artifactCardMinWidth + artifactGridGap)))

/** Cap only the viewport; the virtual list retains every row beyond it. */
export const artifactGridHeight = (rows: number, cardHeight: number) => {
  const visibleRows = Math.min(rows, maxVisibleRows)
  return visibleRows * cardHeight + Math.max(0, visibleRows - 1) * artifactGridGap
}

/** Measure the actual modal width and card surface, independent of viewport breakpoints. */
export const useProjectArtifactGridState = (artifacts: ProjectArtifact[]) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState({ columns: 1, cardHeight: 258 })
  const [focusedId, setFocusedId] = useState<string | null>(null)

  useLayoutEffect(() => {
    const element = scrollRef.current!
    // Measure before paint so opening does not mount a one-column grid first.
    setMetrics((current) => ({ ...current, columns: artifactGridColumns(element.clientWidth) }))
    const observer = new ResizeObserver(([entry]) => {
      const columns = artifactGridColumns(entry.contentRect.width)
      setMetrics((current) => (current.columns === columns ? current : { ...current, columns }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const measureCard = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      return
    }
    // Feedback below the link may grow an individual row; it must not enlarge
    // the viewport enough to expose a fourth ordinary row.
    const surface = element.querySelector('a')!
    const observer = new ResizeObserver(([entry]) => {
      const style = getComputedStyle(element)
      const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
      const cardHeight = entry.contentRect.height + border
      if (cardHeight > 0) {
        setMetrics((current) => (current.cardHeight === cardHeight ? current : { ...current, cardHeight }))
      }
    })
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  const rows = useMemo(
    () =>
      Array.from({ length: Math.ceil(artifacts.length / metrics.columns) }, (_, index) =>
        artifacts.slice(index * metrics.columns, (index + 1) * metrics.columns),
      ),
    [artifacts, metrics.columns],
  )
  const focusedIndex = artifacts.findIndex((artifact) => artifact.id === focusedId)

  return {
    scrollRef,
    measureCard,
    rows,
    columns: metrics.columns,
    rowHeight: metrics.cardHeight + artifactGridGap,
    height: artifactGridHeight(rows.length, metrics.cardHeight),
    // Retain keyboard focus and any open card menu/dialog while scrolling.
    keepMounted: focusedIndex < 0 ? [] : [Math.floor(focusedIndex / metrics.columns)],
    focusCard: setFocusedId,
  }
}
