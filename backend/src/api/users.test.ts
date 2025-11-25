import { usersTable } from '@/db/schema'
import { createApp } from '@/index'
import { createTestDb } from '@/test-utils/db'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

describe('Users API', () => {
  let app: Awaited<ReturnType<typeof createApp>>
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    app = await createApp({ database: db })
  })

  afterEach(async () => {
    await cleanup()
  })

  it('should start with an empty users table', async () => {
    const response = await app.handle(new Request('http://localhost/v1/users'))
    const users = await response.json()

    expect(response.status).toBe(200)
    expect(users).toEqual([])
  })

  it('should create and retrieve a user', async () => {
    const newUser = {
      name: 'Test User',
      age: 25,
      email: 'test@example.com',
    }

    // Create user
    const createResponse = await app.handle(
      new Request('http://localhost/v1/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(newUser),
      }),
    )

    expect(createResponse.status).toBe(200)
    const createdUser = await createResponse.json()
    expect(createdUser).toMatchObject(newUser)
    expect(createdUser.id).toBeDefined()

    // Verify directly in DB
    const dbUsers = await db.select().from(usersTable)
    expect(dbUsers).toHaveLength(1)
    expect(dbUsers[0]).toMatchObject(newUser)

    // Verify via API
    const listResponse = await app.handle(new Request('http://localhost/v1/users'))
    const users = await listResponse.json()
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject(newUser)
  })
})
