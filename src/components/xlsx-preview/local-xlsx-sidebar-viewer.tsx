/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PreviewClient } from '@/office/xlsx-preview-client'
import { DocumentPreviewFrame } from '@/widgets/document-result/document-preview-frame'
import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'
import { XlsxPreview } from './xlsx-preview'

type LocalXlsxSidebarViewerProps = {
  localFileId: string
  fileName: string
  createClient?: () => PreviewClient
}

/** Preview a workbook from this device's attachment store, attached by the user or created by the agent. */
export const LocalXlsxSidebarViewer = ({ localFileId, fileName, createClient }: LocalXlsxSidebarViewerProps) => {
  const state = useLocalDocumentBlob(localFileId, 'unsupported')
  return (
    <DocumentPreviewFrame fileName={fileName} state={state}>
      {({ blob }) => <XlsxPreview blob={blob} createClient={createClient} />}
    </DocumentPreviewFrame>
  )
}
