import * as settingsModule from '@/config/settings'
import { clearSettingsCache } from '@/config/settings'
import type { ConsoleSpies } from '@/test-utils/console-spies'
import { setupConsoleSpy } from '@/test-utils/console-spies'
import { mockAuth, mockAuthUnauthenticated } from '@/test-utils/mock-auth'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { clearTickets, createWsTicket } from './ws-ticket'
import { createWsTicketRoutes } from './ws-ticket-routes'

const ENV_KEYS = ['ALLOW_CUSTOM_AGENTS'] as const
let savedEnv: Partial<Record<string, string | undefined>>

let app: { handle: Elysia['handle'] }
let consoleSpies: ConsoleSpies
let getSettingsSpy: ReturnType<typeof spyOn>

const defaultSettings = {
  fireworksApiKey: '',
  mistralApiKey: '',
  anthropicApiKey: '',
  exaApiKey: '',
  thunderboltInferenceUrl: '',
  thunderboltInferenceApiKey: '',
  monitoringToken: '',
  googleClientId: '',
  googleClientSecret: '',
  microsoftClientId: '',
  microsoftClientSecret: '',
  logLevel: 'INFO' as const,
  port: 8000,
  appUrl: 'http://localhost:1420',
  posthogHost: '',
  posthogApiKey: '',
  corsOrigins: '',
  corsAllowCredentials: true,
  corsAllowMethods: '',
  corsAllowHeaders: '',
  corsExposeHeaders: '',
  waitlistEnabled: false,
  waitlistAutoApproveDomains: '',
  powersyncUrl: '',
  powersyncJwtKid: '',
  powersyncJwtSecret: '',
  powersyncTokenExpirySeconds: 3600,
  authMode: 'consumer' as const,
  oidcClientId: '',
  oidcClientSecret: '',
  oidcIssuer: '',
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
  rateLimitEnabled: false,
  swaggerEnabled: false,
  trustedProxy: '' as const,
  enabledAgents: '',
  allowCustomAgents: false,
}

const post = (body?: unknown) => {
  const init: RequestInit = { method: 'POST' }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return app.handle(new Request('http://localhost/ws-ticket', init))
}

const postRaw = (rawBody: string) =>
  app.handle(
    new Request('http://localhost/ws-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    }),
  )

beforeAll(() => {
  consoleSpies = setupConsoleSpy()
})

afterAll(() => {
  consoleSpies.restore()
})

beforeEach(() => {
  clearTickets()
  clearSettingsCache()
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  getSettingsSpy = spyOn(settingsModule, 'getSettings').mockReturnValue({
    ...defaultSettings,
    allowCustomAgents: false,
  })
  app = new Elysia().use(createWsTicketRoutes(mockAuth))
})

afterEach(() => {
  getSettingsSpy.mockRestore()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key]
    } else {
      delete process.env[key]
    }
  }
  clearSettingsCache()
})

describe('ws-ticket-routes', () => {
  it('returns a ticket for POST with valid payload and allowCustomAgents=true', async () => {
    getSettingsSpy.mockReturnValue({ ...defaultSettings, allowCustomAgents: true })

    const res = await post({ payload: { url: 'wss://agent.example.com/ws' } })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ticket: string }
    expect(json.ticket).toBeDefined()
    expect(typeof json.ticket).toBe('string')
    expect(json.ticket.length).toBeGreaterThan(0)
  })

  it('returns 400 for malformed JSON body', async () => {
    const res = await postRaw('not valid json{')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Invalid JSON body')
  })

  it('returns 400 when URL fails regex validation', async () => {
    getSettingsSpy.mockReturnValue({ ...defaultSettings, allowCustomAgents: true })

    const res = await post({ payload: { url: 'ftp://invalid.example.com' } })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Invalid or oversized URL')
  })

  it('returns 400 when URL is oversized', async () => {
    getSettingsSpy.mockReturnValue({ ...defaultSettings, allowCustomAgents: true })

    const longUrl = 'https://example.com/' + 'a'.repeat(2100)
    const res = await post({ payload: { url: longUrl } })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Invalid or oversized URL')
  })

  it('returns 400 when authMethod is oversized', async () => {
    getSettingsSpy.mockReturnValue({ ...defaultSettings, allowCustomAgents: true })

    const res = await post({
      payload: { url: 'wss://agent.example.com/ws', authMethod: 'x'.repeat(5000) },
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Oversized authMethod')
  })

  it('returns 403 when allowCustomAgents=false and URL is present', async () => {
    const res = await post({ payload: { url: 'wss://agent.example.com/ws' } })
    expect(res.status).toBe(403)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Custom agents are not allowed')
  })

  it('returns a ticket when no payload is provided', async () => {
    const res = await post({})
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ticket: string }
    expect(json.ticket).toBeDefined()
    expect(typeof json.ticket).toBe('string')
  })

  it('returns 401 when no valid session is present', async () => {
    const unauthApp = new Elysia().use(createWsTicketRoutes(mockAuthUnauthenticated))
    const res = await unauthApp.handle(
      new Request('http://localhost/ws-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 429 with Retry-After when TicketQuotaError is thrown', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    // Fill the per-user quota for the mockAuth user id
    for (let i = 0; i < 20; i++) {
      createWsTicket('test-user')
    }
    const res = await post({})
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('Ticket quota exceeded')
    warnSpy.mockRestore()
  })
})
