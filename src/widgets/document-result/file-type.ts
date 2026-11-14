/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** How the side view previews a file. Kept free of runtime imports: the entry chunk reads it. */
export type FileType = 'pdf' | 'docx' | 'xlsx' | 'unsupported'

/**
 * The preview a file gets, by its name. An `.xlsm` previews as a workbook too, since Excelize only reads it and never
 * runs a macro; a bare `xlsx` with no dot is no workbook.
 */
export const getFileType = (fileName: string): FileType => {
  if (/\.xls[xm]$/i.test(fileName)) {
    return 'xlsx'
  }
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') {
    return 'pdf'
  }
  if (ext === 'docx') {
    return 'docx'
  }
  return 'unsupported'
}
