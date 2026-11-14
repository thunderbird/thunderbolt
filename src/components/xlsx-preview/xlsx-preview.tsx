/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useFormatters } from '@/i18n/use-formatters'
import { xlsxPreviewLimits } from '@/office/constants'
import { createPreviewClient, type PreviewClient } from '@/office/xlsx-preview-client'
import { Loader2 } from 'lucide-react'
import { useId } from 'react'
import { LeftOutBanner } from './left-out-banner'
import { PreviewNotice } from './preview-notice'
import { SheetGrid } from './sheet-grid'
import { SheetTabs } from './sheet-tabs'
import { useXlsxPreviewState } from './use-xlsx-preview-state'

type XlsxPreviewProps = {
  blob: Blob
  /** The file's id: a preview mounted again for it reopens on the sheet the user last picked. */
  fileId: string
  /** Starts the Worker that reads the workbook. A test passes one that reads in process. */
  createClient?: () => PreviewClient
}

const Loading = () => (
  <div role="status" className="flex flex-1 items-center justify-center">
    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
    <span className="sr-only">
      <Trans>Loading the workbook</Trans>
    </span>
  </div>
)

const WorkbookPreview = ({ blob, fileId, createClient }: Required<XlsxPreviewProps>) => {
  const panelId = useId()
  const { state, selectSheet } = useXlsxPreviewState(blob, createClient, fileId)

  if (state.status === 'loading') {
    return <Loading />
  }
  if (state.status === 'error' && state.failure === 'tooLarge') {
    return (
      <PreviewNotice title={<Trans>This workbook is too large to preview</Trans>}>
        <Trans>Download the file to open it in a spreadsheet app.</Trans>
      </PreviewNotice>
    )
  }
  // Excelize did not load, for example on a slow or broken network. The file itself may be fine.
  if (state.status === 'error' && state.failure === 'notLoaded') {
    return (
      <PreviewNotice title={<Trans>The preview couldn't load</Trans>}>
        <Trans>Check your connection and open the file again, or download it to open it in a spreadsheet app.</Trans>
      </PreviewNotice>
    )
  }
  if (state.status === 'error') {
    return (
      <PreviewNotice title={<Trans>This workbook can't be previewed</Trans>}>
        <Trans>
          It may be damaged or protected with a password. Download the file to open it in a spreadsheet app.
        </Trans>
      </PreviewNotice>
    )
  }
  const { overview, sheetIndex, sheet } = state
  if (overview.sheets.length === 0) {
    return (
      <PreviewNotice title={<Trans>This workbook has no visible sheets</Trans>}>
        <Trans>Download the file to open it in a spreadsheet app.</Trans>
      </PreviewNotice>
    )
  }
  const sheetBody = () => {
    if (overview.sheets[sheetIndex].tooLarge) {
      return (
        <PreviewNotice title={<Trans>This sheet is too large to preview</Trans>}>
          <Trans>Download the file to open it in a spreadsheet app.</Trans>
        </PreviewNotice>
      )
    }
    return sheet ? <SheetGrid key={sheet.index} name={overview.sheets[sheet.index].name} sheet={sheet} /> : <Loading />
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LeftOutBanner overview={overview} layout={sheet?.layout} />
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${panelId}-tab-${sheetIndex}`}
        className="flex min-h-0 flex-1 flex-col bg-white"
      >
        {sheetBody()}
      </div>
      <SheetTabs
        names={overview.sheets.map(({ name }) => name)}
        selected={sheetIndex}
        onSelect={selectSheet}
        panelId={panelId}
      />
    </div>
  )
}

/**
 * A workbook as a read-only grid: the note on what it leaves out, the selected sheet and the sheet tabs. A file over
 * the size limit is refused before any Worker starts or Excelize downloads; the header's Download still works.
 */
export const XlsxPreview = ({ blob, fileId, createClient = createPreviewClient }: XlsxPreviewProps) => {
  const formatters = useFormatters()
  if (blob.size > xlsxPreviewLimits.fileBytes) {
    const limit = formatters.number(xlsxPreviewLimits.fileBytes / 1024 / 1024)
    return (
      <PreviewNotice title={<Trans>This workbook is too large to preview</Trans>}>
        <Trans>The preview opens workbooks up to {limit} MB. Download the file to open it in a spreadsheet app.</Trans>
      </PreviewNotice>
    )
  }
  return <WorkbookPreview blob={blob} fileId={fileId} createClient={createClient} />
}
