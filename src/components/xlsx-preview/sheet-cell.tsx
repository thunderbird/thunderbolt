/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PreviewCell } from '@/office/xlsx-preview-reader'
import type { CSSProperties } from 'react'
import type { MergeBox } from './sheet-geometry'

const linkColor = '#0563c1'

// The look every cell shares is a class, so a cell's inline style holds only what the file sets. With a dozen
// properties set inline on two elements per cell, about half of WebKit's scroll frames took over 50 ms.
// The sheet uses Excel's pure white, because the app's `white` is a warm one.
const cellLook =
  'box-border flex items-end overflow-hidden whitespace-nowrap border-e border-b border-[#e1e1e1] bg-[#fff] px-0.5'

// The active outline marks the cell itself, not the empty cells its text runs into.
const activeOutline =
  'group-focus/grid:after:pointer-events-none group-focus/grid:after:absolute group-focus/grid:after:inset-0 group-focus/grid:after:border-2 group-focus/grid:after:border-primary'

const activeMergeOutline =
  'group-focus/grid:outline-2 group-focus/grid:-outline-offset-2 group-focus/grid:outline-primary'

const justify = { left: 'flex-start', center: 'center', right: 'flex-end', justify: 'flex-start' } as const

/** The horizontal alignment of a cell's text: the file's, or else Excel's General alignment for the cell's value. */
export const textAlignOf = (css: CSSProperties | undefined, cell: PreviewCell | undefined) => {
  const explicit = css?.textAlign
  if (explicit === 'left' || explicit === 'center' || explicit === 'right' || explicit === 'justify') {
    return explicit
  }
  return cell?.align === 'end' ? 'right' : cell?.align === 'center' ? 'center' : 'left'
}

type SheetCellProps = {
  id: string
  col: number
  /** The cell's place in the shown rows and columns, for picking it with the pointer. */
  position: { row: number; col: number }
  width: number
  /** Drawn out of flow at this size when the cell is merged or its text runs into the empty cells after it. */
  box?: { width: number; height: number }
  merge?: MergeBox
  /** Where a frozen column sticks, from the start of the grid. */
  frozenAt?: number
  cell?: PreviewCell
  css?: CSSProperties
  active: boolean
}

/**
 * One cell, drawn as the spreadsheet shows it. The text is a React text node and the styles are the sanitized ones
 * from `cellCss`. A link looks like one but is plain text: it has no `href` and nothing happens on a click. A plain
 * cell is one element. A merged cell, or one whose text runs into the next cells, is a wrapper around a box drawn
 * out of flow.
 */
export const SheetCell = ({ id, col, position, width, box, merge, frozenAt, cell, css, active }: SheetCellProps) => {
  const sticky = frozenAt === undefined ? '' : ' sticky z-[2]'
  const look: CSSProperties = {
    ...css,
    justifyContent: justify[textAlignOf(css, cell)],
    color: css?.color ?? (cell?.link ? linkColor : undefined),
    textDecoration: css?.textDecoration ?? (cell?.link ? 'underline' : undefined),
  }
  const text = <span className="min-w-0 overflow-hidden">{cell?.text}</span>
  const gridcell = {
    id,
    role: 'gridcell',
    'aria-colindex': col + 2,
    'data-row': position.row,
    'data-col': position.col,
  }

  if (!box) {
    return (
      <div
        {...gridcell}
        className={`${cellLook} flex-none${sticky || (active ? ' relative' : '')}${active ? ` ${activeOutline}` : ''}`}
        style={{ ...look, width, insetInlineStart: frozenAt }}
      >
        {text}
      </div>
    )
  }
  return (
    <div
      {...gridcell}
      aria-colspan={merge && merge.cols > 1 ? merge.cols : undefined}
      aria-rowspan={merge && merge.rows > 1 ? merge.rows : undefined}
      className={`flex-none${sticky || ' relative z-[1]'}${active && !merge ? ` ${activeOutline}` : ''}`}
      style={{ width, insetInlineStart: frozenAt }}
    >
      <div
        className={`${cellLook} absolute start-0 top-0${active && merge ? ` ${activeMergeOutline}` : ''}`}
        style={{ ...look, width: box.width, height: box.height }}
      >
        {text}
      </div>
    </div>
  )
}
