/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { explainTypeErrors } from './excelize-type-errors'
import { loadTestEngine } from './xlsx-preview-test-runtime'

const { excelize } = await loadTestEngine()
explainTypeErrors(excelize)

const series = [{ Name: 'Sheet1!$A$2', Categories: 'Sheet1!$B$1:$D$1', Values: 'Sheet1!$B$2:$D$2' }]

describe('explainTypeErrors', () => {
  it('names the option field that has the wrong type, and the kinds Excelize takes there', () => {
    const f = excelize.NewFile()
    // @ts-expect-error A script sends a string where Excelize expects a chart type constant.
    expect(f.AddChart('Sheet1', 'E1', { Type: 'col', Series: series })).toEqual({
      error: 'invalid argument data type: argument 3.Type is a string, where Excelize takes a number',
    })
  })

  it('finds a wrong field inside an array of objects', () => {
    const f = excelize.NewFile()
    // @ts-expect-error A script sends a number as a series name.
    const { error } = f.AddChart('Sheet1', 'E1', { Type: excelize.Col, Series: [{ ...series[0], Name: 3 }] })
    expect(error).toBe(
      'invalid argument data type: argument 3.Series[0].Name is a number, where Excelize takes a string',
    )
  })

  it('names a chart title given as plain text', () => {
    const f = excelize.NewFile()
    // @ts-expect-error A script sends the title as a string.
    expect(f.AddChart('Sheet1', 'E1', { Type: excelize.Col, Series: series, Title: 'Budget' }).error).toBe(
      'invalid argument data type: argument 3.Title is a string, where Excelize takes an array or an object',
    )
  })

  it('lists the arguments when no single value explains the failure', () => {
    const f = excelize.NewFile()
    // @ts-expect-error Two wrong fields at once.
    expect(f.AddChart('Sheet1', 'E1', { Type: 'col', Series: series, Title: 'Budget' }).error).toBe(
      'invalid argument data type: the arguments are a string, a string, an object',
    )
  })

  it('names a wrong argument', () => {
    const f = excelize.NewFile()
    // @ts-expect-error The bridge sends a missing value as null.
    expect(f.SetCellStyle('Sheet1', 'A1', 'A1', null).error).toBe(
      'invalid argument data type: argument 4 is null, where Excelize takes a number',
    )
  })

  it('probes on a workbook of its own, so the failed call changes nothing', () => {
    const f = excelize.NewFile()
    f.SetCellValue('Sheet1', 'A1', 'kept')
    // @ts-expect-error The bridge sends a missing value as null.
    expect(f.SetCellValue('Sheet1', 'A1', null).error).toStartWith('invalid argument data type: argument 3 is null')
    expect(f.GetCellValue('Sheet1', 'A1').value).toBe('kept')
  })

  it('leaves calls that succeed, or fail for another reason, as they were', () => {
    const f = excelize.NewFile()
    expect(f.AddChart('Sheet1', 'E1', { Type: excelize.Col, Series: series })).toEqual({ error: null })
    expect(f.SetCellValue('Nope', 'A1', 1)).toEqual({ error: 'sheet Nope does not exist' })
    expect(excelize.CellNameToCoordinates('B3')).toEqual({ col: 2, row: 3, error: null })
  })

  it('explains the type errors of the pure helpers too', () => {
    // @ts-expect-error A script sends a column name where Excelize expects its number.
    expect(excelize.ColumnNumberToName('B').error).toBe(
      'invalid argument data type: argument 1 is a string, where Excelize takes a number',
    )
  })
})
