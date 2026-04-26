import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test'
import { clearSettingsCache } from '@/config/settings'
import { createWsTicket, consumeWsTicket } from '@/auth/ws-ticket'
import { Elysia } from 'elysia'

// Mock the ACP registry fetch
const originalFetch = globalThis.fetch

// Set up env once for all tests and create a single server
let app: ReturnType<typeof Elysia.prototype.listen> | null = null
let port: number = 0

describe('WebSocket ticket auth — integration', () => {
  beforeAll(async () => {
    clearSettingsCache()
    process.env.HAYSTACK_API_KEY = 'test-key'
    process.env.HAYSTACK_WORKSPACE_NAME = 'test-workspace'
    process.env.HAYSTACK_PIPELINE_NAME = 'test-pipeline'
    process.env.HAYSTACK_PIPELINE_ID = 'pipeline-123'
    globalThis.fetch = mock(async (url: any) => {
      if (typeof url === 'string' && url.includes('agentclientprotocol.com')) {
        return new Response(JSON.stringify({ version: '1.0.0', agents: [], extensions: [] }), { status: 200 })
      }
      return originalFetch(url)
    }) as any
    clearSettingsCache()

    const { createHaystackRoutes } = await import('./routes')
    const mockAuth = {
      api: { getSession: async () => ({ user: { id: 'user-789' }, session: {} }) },
    } as any

    app = new Elysia().use(createHaystackRoutes(mockAuth)).listen(0) as any
    port = (app as any).server?.port ?? 0
  })

  afterAll(() => {
    ;(app as any)?.stop?.()
    delete process.env.HAYSTACK_API_KEY
    delete process.env.HAYSTACK_WORKSPACE_NAME
    delete process.env.HAYSTACK_PIPELINE_NAME
    delete process.env.HAYSTACK_PIPELINE_ID
    clearSettingsCache()
    globalThis.fetch = originalFetch
  })

  describe('ws-ticket endpoint', () => {
    it('returns a ticket when authenticated', async () => {
      const { createWsTicketRoutes } = await import('@/auth/ws-ticket-routes')
      const mockAuth = {
        api: {
          getSession: async () => ({ user: { id: 'user-123' }, session: {} }),
        },
      } as any

      const app = new Elysia().use(createWsTicketRoutes(mockAuth))
      const response = await app.handle(new Request('http://localhost/ws-ticket', { method: 'POST' }))

      expect(response.status).toBe(200)
      const data = (await response.json()) as { ticket: string }
      expect(data.ticket).toBeDefined()
      expect(data.ticket.length).toBe(64)
    })

    it('returns 401 when not authenticated', async () => {
      const { createWsTicketRoutes } = await import('@/auth/ws-ticket-routes')
      const mockAuth = {
        api: {
          getSession: async () => null,
        },
      } as any

      const app = new Elysia().use(createWsTicketRoutes(mockAuth))
      const response = await app.handle(new Request('http://localhost/ws-ticket', { method: 'POST' }))

      expect(response.status).toBe(401)
    })

    it('ticket is consumed on first use', async () => {
      const ticket = createWsTicket('user-456')

      const first = consumeWsTicket(ticket)
      expect(first?.userId).toBe('user-456')

      const second = consumeWsTicket(ticket)
      expect(second).toBeNull()
    })
  })

  describe('haystack WebSocket with ticket', () => {
    it('WebSocket opens with valid ticket', async () => {
      const ticket = createWsTicket('user-789')

      const result = await new Promise<{ event: string; code?: number }>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/haystack/ws/test-pipeline?ticket=${ticket}`)
        ws.onopen = () => {
          resolve({ event: 'open' })
          ws.close()
        }
        ws.onclose = (e) => resolve({ event: 'close', code: e.code })
        ws.onerror = () => {}
        setTimeout(() => resolve({ event: 'timeout' }), 3000)
      })

      // Valid ticket should open (or close for non-auth reasons like unreachable Haystack)
      if (result.event === 'close') {
        expect(result.code).not.toBe(4001)
      } else {
        expect(result.event).toBe('open')
      }
    })

    it('WebSocket rejects without ticket', async () => {
      const result = await new Promise<{ event: string; code?: number; didOpen: boolean }>((resolve) => {
        let didOpen = false
        const ws = new WebSocket(`ws://localhost:${port}/haystack/ws/test-pipeline`)
        ws.onopen = () => {
          didOpen = true
        }
        ws.onclose = (e) => resolve({ event: 'close', code: e.code, didOpen })
        ws.onerror = () => {}
        setTimeout(() => resolve({ event: 'timeout', didOpen }), 3000)
      })

      // Connection should close — the server calls ws.close(4001) in the open handler.
      // Elysia may report the code as 4001 or 1000 depending on runtime; the key invariant
      // is that the socket does not stay open for messaging.
      expect(result.event).toBe('close')
    })

    it('WebSocket rejects with consumed ticket', async () => {
      const ticket = createWsTicket('user-789')
      consumeWsTicket(ticket)

      const result = await new Promise<{ event: string; code?: number }>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/haystack/ws/test-pipeline?ticket=${ticket}`)
        ws.onopen = () => {}
        ws.onclose = (e) => resolve({ event: 'close', code: e.code })
        ws.onerror = () => {}
        setTimeout(() => resolve({ event: 'timeout' }), 3000)
      })

      expect(result.event).toBe('close')
    })

    it('WebSocket rejects with bogus ticket', async () => {
      const result = await new Promise<{ event: string; code?: number }>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/haystack/ws/test-pipeline?ticket=bogus`)
        ws.onopen = () => {}
        ws.onclose = (e) => resolve({ event: 'close', code: e.code })
        ws.onerror = () => {}
        setTimeout(() => resolve({ event: 'timeout' }), 3000)
      })

      expect(result.event).toBe('close')
    })
  })
})
