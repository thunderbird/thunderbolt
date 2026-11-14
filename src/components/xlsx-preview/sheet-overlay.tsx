/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import type { Overlay } from '@/office/xlsx-preview-reader'
import { ChartNoAxesColumn } from 'lucide-react'
import { type CSSProperties, memo } from 'react'
import { chartKindLabels } from './chart-labels'
import { ChartSvg } from './chart-svg'
import { headerHeight, rowHeaderWidth } from './sheet-geometry'
import { useImageUrls } from './sheet-image'

type PlaceholderOverlay = Extract<Overlay, { type: 'placeholder' }>

/** A chart's name, its type and title: what the visually hidden list of charts and pictures reads out. */
const useChartName = () => {
  const { t, i18n } = useLingui()
  return ({ kind, title }: Extract<Overlay, { type: 'chart' | 'placeholder' }>) => {
    const kindLabel = i18n._(chartKindLabels[kind])
    return title ? t`${kindLabel}: ${title}` : kindLabel
  }
}

/** A box in place of a chart of a type the preview does not draw, naming that type. */
const ChartPlaceholder = ({ chart, style }: { chart: PlaceholderOverlay; style: CSSProperties }) => {
  const { i18n } = useLingui()
  return (
    // The chart sits on the sheet, which stays white in dark mode, so it keeps light-paper colours.
    <div
      style={style}
      className="flex flex-col items-center justify-center gap-1 overflow-hidden rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-3 text-center text-neutral-600"
    >
      <ChartNoAxesColumn className="size-[var(--icon-size-default)] text-neutral-400" aria-hidden="true" />
      <span className="text-[length:var(--font-size-sm)] font-medium text-neutral-800">
        {i18n._(chartKindLabels[chart.kind])}
      </span>
      {chart.title && <span className="max-w-full truncate text-[length:var(--font-size-xs)]">{chart.title}</span>}
      <span className="text-[length:var(--font-size-xs)]">
        <Trans>Not shown in this preview</Trans>
      </span>
    </div>
  )
}

/** A picture, chart or chart placeholder at the place its anchor gives on the sheet. */
const SheetOverlay = ({ overlay, url }: { overlay: Overlay; url?: string }) => {
  const style: CSSProperties = {
    position: 'absolute',
    insetInlineStart: rowHeaderWidth + overlay.x,
    top: headerHeight + overlay.y,
    width: overlay.width,
    height: overlay.height,
    zIndex: 1,
  }
  switch (overlay.type) {
    case 'image':
      return url ? <img src={url} alt="" draggable={false} style={{ ...style, objectFit: 'fill' }} /> : null
    case 'chart':
      return <ChartSvg chart={overlay} style={style} />
    case 'placeholder':
      return <ChartPlaceholder chart={overlay} style={style} />
  }
}

/**
 * The sheet's charts and pictures, drawn over its cells. The layer is hidden from assistive technology, which would
 * find no cell in it, and `OverlayList`, outside the grid, names each one instead. The layer is memoized, so moving
 * the active cell does not draw the charts again.
 */
export const SheetOverlays = memo(({ overlays }: { overlays: Overlay[] }) => {
  const urls = useImageUrls(overlays)
  return (
    <div aria-hidden="true">
      {overlays.map((overlay, i) => (
        <SheetOverlay key={i} overlay={overlay} url={overlay.type === 'image' ? urls.get(overlay.bytes) : undefined} />
      ))}
    </div>
  )
})
SheetOverlays.displayName = 'SheetOverlays'

/** A visually hidden list of the sheet's charts and pictures, each by its type and title or its description. */
export const OverlayList = ({ overlays }: { overlays: Overlay[] }) => {
  const { t } = useLingui()
  const chartName = useChartName()
  if (overlays.length === 0) {
    return null
  }
  return (
    <ul className="sr-only" aria-label={t`Charts and pictures`}>
      {overlays.map((overlay, i) => (
        <li key={i}>
          {overlay.type === 'image' ? overlay.alt || t`Picture` : chartName(overlay)}
          {overlay.type === 'placeholder' && (
            <>
              {' '}
              <Trans>Not shown in this preview</Trans>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
