export type DocumentFile = {
  id: string
  name: string
}

export type DocumentMeta = {
  id: string
  content: string
  score: number
  file: DocumentFile
}

export type DocumentReference = {
  position: number
  fileId: string
  fileName: string
  pageNumber?: number
}
