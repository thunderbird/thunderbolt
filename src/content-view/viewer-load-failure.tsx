/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { PreviewNotice } from '@/components/preview-notice'
import { useHttpClient } from '@/contexts'
import { DocumentPreviewFrame } from '@/widgets/document-result/document-preview-frame'
import { getFileType } from '@/widgets/document-result/file-type'
import {
  type DocumentBlobState,
  useDocumentBlob,
  useLocalDocumentBlob,
} from '@/widgets/document-result/use-document-blob'
import { FileSpreadsheet, FileText, Presentation } from 'lucide-react'

const icons = { docx: FileText, pptx: Presentation, xlsx: FileSpreadsheet, pdf: FileText, unsupported: FileText }

// Loaded as `unsupported`, so only the bytes are fetched, for Download, and no renderer.
// A failed viewer load is remembered until the app reloads, so opening the file again would not help.
const LoadFailure = ({ fileName, state }: { fileName: string; state: DocumentBlobState }) => (
  <DocumentPreviewFrame fileName={fileName} state={state}>
    {() => (
      <PreviewNotice icon={icons[getFileType(fileName)]} title={<Trans>The preview couldn't load</Trans>}>
        <Trans>Check your connection and reload the app, or download the file.</Trans>
      </PreviewNotice>
    )}
  </DocumentPreviewFrame>
)

type ViewerLoadFailureProps = { fileId: string; fileName: string }

/** Replaces a Haystack document's viewer whose code did not load. The panel says so, and Download still works. */
export const ViewerLoadFailure = ({ fileId, fileName }: ViewerLoadFailureProps) => {
  const httpClient = useHttpClient()
  const state = useDocumentBlob(fileId, 'unsupported', httpClient)
  return <LoadFailure fileName={fileName} state={state} />
}

/** Replaces a local attachment's viewer whose code did not load. Download saves the copy stored on this device. */
export const LocalViewerLoadFailure = ({ fileId, fileName }: ViewerLoadFailureProps) => {
  const state = useLocalDocumentBlob(fileId, 'unsupported')
  return <LoadFailure fileName={fileName} state={state} />
}
