import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { getIntegrationStatuses } from './integrations'
import { updateSettings } from './settings'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

describe('getIntegrationStatuses', () => {
  it('should return empty statuses when no integrations are connected', async () => {
    const statuses = await getIntegrationStatuses()

    expect(statuses.google).toBeUndefined()
    expect(statuses.microsoft).toBeUndefined()
    expect(statuses.doNotAskAgain).toBe(false)
  })

  it('should include integration when credentials exist (connected)', async () => {
    await updateSettings({ integrations_google_credentials: '{"token":"test"}' })

    const statuses = await getIntegrationStatuses()

    expect(statuses.google).toBeDefined()
    expect(statuses.google?.enabled).toBe(false)
    expect(statuses.microsoft).toBeUndefined()
  })

  it('should show enabled status when integration is enabled', async () => {
    await updateSettings({
      integrations_google_credentials: '{"token":"test"}',
      integrations_google_is_enabled: true,
    })

    const statuses = await getIntegrationStatuses()

    expect(statuses.google).toBeDefined()
    expect(statuses.google?.enabled).toBe(true)
  })

  it('should return doNotAskAgain status', async () => {
    await updateSettings({ integrations_do_not_ask_again: true })

    const statuses = await getIntegrationStatuses()

    expect(statuses.doNotAskAgain).toBe(true)
  })

  it('should only check requested integrations', async () => {
    await updateSettings({
      integrations_google_credentials: '{"token":"test"}',
      integrations_microsoft_credentials: '{"token":"test"}',
    })

    const statuses = await getIntegrationStatuses(['google'])

    expect(statuses.google).toBeDefined()
    expect(statuses.microsoft).toBeUndefined()
  })
})
