/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { useFormatters } from '@/i18n/use-formatters'
import { xlsxPreviewLimits } from '@/office/constants'
import type { SheetLayout, WorkbookOverview } from '@/office/xlsx-preview-reader'
import { Info } from 'lucide-react'

type LeftOutBannerProps = {
  overview: WorkbookOverview
  /** The sheet on show, once read. Only its layout knows what the sheet leaves out. */
  layout?: SheetLayout
}

/**
 * One short note listing what the preview leaves out of the file. For rows and columns past the caps, it says how many
 * are shown and how many the sheet has. It renders nothing when nothing is left out.
 */
export const LeftOutBanner = ({ overview, layout }: LeftOutBannerProps) => {
  const { t } = useLingui()
  const formatters = useFormatters()
  const { leftOut, sheets } = overview
  const { rows: maxRows, columns: maxCols, cellChars } = xlsxPreviewLimits
  const leftOutObjects = layout?.leftOutObjects ?? 0
  const notes: [boolean, string][] = [
    [
      leftOutObjects > 0,
      plural(leftOutObjects, {
        one: '# chart or picture not shown in full',
        other: '# charts or pictures not shown in full',
      }),
    ],
    [leftOut.hiddenSheets > 0, plural(leftOut.hiddenSheets, { one: '# hidden sheet', other: '# hidden sheets' })],
    [leftOut.chartSheets > 0, plural(leftOut.chartSheets, { one: '# chart sheet', other: '# chart sheets' })],
    [leftOut.conditionalFormats, t`Conditional formatting`],
    [
      leftOut.missingResults > 0,
      plural(leftOut.missingResults, {
        one: '# formula with no saved result',
        other: '# formulas with no saved result',
      }),
    ],
    [
      leftOut.unsupportedCharts > 0,
      plural(leftOut.unsupportedCharts, {
        one: '# chart of a type the preview does not draw',
        other: '# charts of types the preview does not draw',
      }),
    ],
    [leftOut.drawings, t`Shapes and text boxes`],
    [leftOut.sparklines, t`Sparklines`],
    [leftOut.longText, t`Text past the first ${formatters.number(cellChars)} characters of a cell`],
    // A sheet too large to read says so in its own notice, since none of its rows are shown.
    ...sheets
      .filter(({ tooLarge }) => !tooLarge)
      .flatMap(({ name, rows, cols }): [boolean, string][] => [
        [
          rows > maxRows,
          t`Rows after the first ${formatters.number(maxRows)} in ${name}, which has ${formatters.number(rows)}`,
        ],
        [
          cols > maxCols,
          t`Columns after the first ${formatters.number(maxCols)} in ${name}, which has ${formatters.number(cols)}`,
        ],
      ]),
  ]
  const items = notes.filter(([shown]) => shown).map(([, text]) => text)

  if (items.length === 0) {
    return null
  }
  return (
    <div
      role="note"
      className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/60 px-3 py-2 text-[length:var(--font-size-xs)] text-muted-foreground"
    >
      <Info className="mt-0.5 size-[var(--icon-size-sm)] shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5">
        <span className="font-medium text-foreground">
          <Trans>This preview leaves out</Trans>
        </span>
        <ul className="contents">
          {items.map((item) => (
            <li key={item} className="flex items-center gap-1.5 before:size-1 before:rounded-full before:bg-current">
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
