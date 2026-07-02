/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocalDocumentBlob } from '@/widgets/document-result/use-document-blob'

type ImageThumbnailProps = {
  localFileId: string
  alt: string
}

/**
 * Fills an attachment card with the actual image, loaded from the locally-stored
 * blob. Reuses {@link useLocalDocumentBlob}, which creates and revokes the object
 * URL on the caller's behalf. Returns null until the blob resolves, so the card's
 * placeholder icon shows underneath and the image fades in on top.
 */
export const ImageThumbnail = ({ localFileId, alt }: ImageThumbnailProps) => {
  const state = useLocalDocumentBlob(localFileId, 'unsupported')
  if (state.status !== 'ready') {
    return null
  }
  return <img src={state.blobUrl} alt={alt} className="absolute inset-0 size-full object-cover" />
}
