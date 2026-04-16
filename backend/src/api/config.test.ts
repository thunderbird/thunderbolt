import { describe, expect, it } from 'bun:test'
import { createConfigRoutes } from './config'

const BASE = 'http://localhost'

describe('Config API', () => {
  const app = createConfigRoutes()

  it('GET /config returns 200 with empty config', async () => {
    const res = await app.handle(new Request(`${BASE}/config`))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })
})
