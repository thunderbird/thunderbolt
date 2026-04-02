import type { Auth } from '@/auth/elysia-plugin'
import { consumeWsTicket } from '@/auth/ws-ticket'
import { Elysia, t } from 'elysia'
import { getSettings, getHaystackPipelines } from '@/config/settings'
import { HaystackClient } from './client'
import { createHaystackWebSocketHandler } from './websocket-handler'

/**
 * Create Haystack routes: file proxy and WebSocket ACP endpoints.
 * Discovery is handled by the generic /agents endpoint.
 * Returns an empty router if Haystack is not configured.
 */
export const createHaystackRoutes = (auth: Auth, fetchFn: typeof fetch = globalThis.fetch) => {
  const settings = getSettings()
  const pipelines = getHaystackPipelines(settings)

  const router = new Elysia({ prefix: '/haystack' })

  if (pipelines.length === 0) {
    return router
  }

  const clients = new Map(
    pipelines.map((p) => [
      p.slug,
      new HaystackClient(
        {
          apiKey: settings.haystackApiKey,
          baseUrl: settings.haystackBaseUrl,
          workspaceName: settings.haystackWorkspace,
          pipelineName: p.pipelineName,
          pipelineId: p.pipelineId,
        },
        fetchFn,
      ),
    ]),
  )

  const anyClient = clients.values().next().value as HaystackClient

  // File proxy route — uses session-based auth (normal HTTP with cookies)
  router.get(
    '/files/:fileId',
    async ({ params, request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const response = await anyClient.downloadFile(params.fileId)

      const headers: Record<string, string> = {}
      const contentType = response.headers.get('content-type')
      if (contentType) {
        headers['content-type'] = contentType
      }
      const contentDisposition = response.headers.get('content-disposition')
      if (contentDisposition) {
        headers['content-disposition'] = contentDisposition
      }

      return new Response(response.body, { headers })
    },
    {
      params: t.Object({ fileId: t.String() }),
    },
  )

  // WebSocket routes — use ticket-based auth (browsers can't send cookies with WS)
  for (const pipeline of pipelines) {
    const client = clients.get(pipeline.slug)!
    const baseHandler = createHaystackWebSocketHandler(pipeline, client)

    router.ws(`/ws/${pipeline.slug}`, {
      open: (ws) => {
        const ticketId = (ws as any).data?.query?.ticket as string | undefined
        if (!ticketId) {
          console.warn(`[haystack] WebSocket rejected — no ticket for ${pipeline.slug}`)
          ws.close(4001, 'Unauthorized')
          return
        }
        const userId = consumeWsTicket(ticketId)
        if (!userId) {
          console.warn(`[haystack] WebSocket rejected — invalid/expired ticket for ${pipeline.slug}`)
          ws.close(4001, 'Unauthorized')
          return
        }
        baseHandler.open(ws as any)
      },
      message: baseHandler.message as any,
      close: baseHandler.close as any,
    })
  }

  return router
}
