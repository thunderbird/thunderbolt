import { getSettings } from '@/dal'
import { getDb } from '@/db/database'
import type { HttpClient } from '@/contexts/http-client-context'
import type { HaystackDocumentMeta } from '@/types'

type HaystackChatParams = {
  query: string
  sessionId: string | null
  httpClient: HttpClient
}

type HaystackChatResult = {
  sessionId: string
  answerText: string
  widgets: string
  documents: HaystackDocumentMeta[]
}

export const sendHaystackMessage = async ({
  query,
  sessionId,
  httpClient,
}: HaystackChatParams): Promise<HaystackChatResult> => {
  const db = getDb()
  const { cloudUrl } = await getSettings(db, { cloud_url: 'http://localhost:8000/v1' })

  // Create session if none exists
  let activeSessionId = sessionId
  if (!activeSessionId) {
    const sessionResponse = await httpClient
      .post(`${cloudUrl}/haystack/sessions`, {})
      .json<{ data: { searchSessionId: string }; success: boolean }>()

    if (!sessionResponse.success) {
      throw new Error('Failed to create Haystack session')
    }
    activeSessionId = sessionResponse.data.searchSessionId
  }

  // Send chat message
  const chatResponse = await httpClient
    .post(`${cloudUrl}/haystack/chat`, {
      json: { query, sessionId: activeSessionId },
    })
    .json<{
      data: {
        queryId: string
        results: Array<{
          answers: Array<{
            answer: string
            files: Array<{ id: string; name: string }>
          }>
          documents: Array<{
            id: string
            content: string
            score: number
            file: { id: string; name: string }
          }>
        }>
      }
      success: boolean
    }>()

  if (!chatResponse.success) {
    throw new Error('Haystack chat request failed')
  }

  const result = chatResponse.data.results[0]
  const answer = result?.answers[0]

  if (!answer) {
    throw new Error('No answer received from Haystack')
  }

  // Format document widgets from source files, excluding low-relevance results (<1%)
  const widgetTags = (answer.files ?? [])
    .filter((file) => {
      const doc = result.documents.find((d) => d.file.id === file.id)
      return doc && doc.score >= 0.01
    })
    .map((file) => {
      const doc = result.documents.find((d) => d.file.id === file.id)
      const snippet = doc?.content ? doc.content.slice(0, 200).replace(/"/g, '&quot;') : ''
      const score = doc?.score?.toFixed(4) ?? ''
      return `<widget:document-result name="${file.name}" fileId="${file.id}" snippet="${snippet}" score="${score}" />`
    })
    .join('\n')

  const documents: HaystackDocumentMeta[] = result.documents.map((d) => ({
    id: d.id,
    content: d.content,
    score: d.score,
    file: d.file,
  }))

  return {
    sessionId: activeSessionId,
    answerText: answer.answer,
    widgets: widgetTags,
    documents,
  }
}
