import { Elysia, t } from 'elysia'
import { getSettings, getHaystackPipelines } from '@/config/settings'
import { HaystackClient } from './client'
import { createHaystackWebSocketHandler } from './websocket-handler'

/**
 * Create Haystack routes: pipeline discovery, file proxy, and WebSocket ACP endpoints.
 * Returns an empty router if Haystack is not configured.
 */
export const createHaystackRoutes = (fetchFn: typeof fetch = globalThis.fetch) => {
  const settings = getSettings()
  const pipelines = getHaystackPipelines(settings)

  const router = new Elysia({ prefix: '/haystack' })

  if (pipelines.length === 0) {
    // Return routes that return empty data when Haystack is not configured
    router.get('/pipelines', () => ({ data: [] }))
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

  // Pipeline discovery endpoint for frontend agent registration
  router.get('/pipelines', () => ({
    data: pipelines.map((p) => ({
      slug: p.slug,
      name: p.name,
      icon: p.icon,
    })),
  }))

  // File download proxy for PDF/DOCX viewer
  router.get(
    '/files/:fileId',
    async ({ params }) => {
      if (!/^[\w-]+$/.test(params.fileId)) {
        throw new Error('Invalid file ID')
      }

      // Use any client — they share the same workspace/auth
      const client = clients.values().next().value
      if (!client) {
        throw new Error('No Haystack client available')
      }

      const response = await client.downloadFile(params.fileId)

      // Pass through content type and disposition headers
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

  // WebSocket ACP endpoint per pipeline
  for (const pipeline of pipelines) {
    const client = clients.get(pipeline.slug)!
    const handler = createHaystackWebSocketHandler(pipeline, client)

    router.ws(`/ws/${pipeline.slug}`, {
      open(ws) {
        handler.open(ws as unknown as Parameters<typeof handler.open>[0])
      },
      message(ws, message) {
        handler.message(ws as unknown as Parameters<typeof handler.message>[0], message as unknown as string | Buffer)
      },
      close(ws) {
        handler.close(ws as unknown as Parameters<typeof handler.close>[0])
      },
    })
  }

  return router
}
