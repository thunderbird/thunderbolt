import { getSettings } from '@/config/settings'
import { memoize } from '@/lib/memoize'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import { HaystackClient } from './client'

const getHaystackClient = memoize((fetchFn: typeof fetch) => {
  const settings = getSettings()

  if (!settings.haystackApiKey) {
    return null
  }

  return new HaystackClient(
    {
      apiKey: settings.haystackApiKey,
      baseUrl: settings.haystackBaseUrl,
      workspaceName: settings.haystackWorkspaceName,
      pipelineName: settings.haystackPipelineName,
      pipelineId: settings.haystackPipelineId,
    },
    fetchFn,
  )
})

export const createHaystackRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia({ prefix: '/haystack' })
    .onError(safeErrorHandler)
    .state('haystackClient', getHaystackClient(fetchFn))
    .post('/sessions', async ({ store }) => {
      if (!store.haystackClient) {
        throw new Error('Haystack service is not configured.')
      }
      const session = await store.haystackClient.createSession()
      return { data: session, success: true }
    })
    .post(
      '/chat',
      async ({ body, store }) => {
        if (!store.haystackClient) {
          throw new Error('Haystack service is not configured.')
        }
        const response = await store.haystackClient.chat({
          query: body.query,
          sessionId: body.sessionId,
          chatHistoryLimit: body.chatHistoryLimit,
        })
        return { data: response, success: true }
      },
      {
        body: t.Object({
          query: t.String(),
          sessionId: t.String(),
          chatHistoryLimit: t.Optional(t.Number()),
        }),
      },
    )
    .get('/sessions', async ({ store }) => {
      if (!store.haystackClient) {
        throw new Error('Haystack service is not configured.')
      }
      const sessions = await store.haystackClient.listSessions()
      return { data: sessions, success: true }
    })
    .get(
      '/files/:fileId',
      async ({ params, store }) => {
        if (!store.haystackClient) {
          throw new Error('Haystack service is not configured.')
        }
        const response = await store.haystackClient.downloadFile(params.fileId)

        const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream'
        const contentDisposition = response.headers.get('Content-Disposition')

        const headers: Record<string, string> = { 'Content-Type': contentType }
        if (contentDisposition) {
          headers['Content-Disposition'] = contentDisposition
        }

        return new Response(response.body, { headers })
      },
      {
        params: t.Object({
          fileId: t.String(),
        }),
      },
    )
}
