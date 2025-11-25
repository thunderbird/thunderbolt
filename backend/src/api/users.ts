import type { db } from '@/db/client'
import { usersTable } from '@/db/schema'
import { Elysia, t } from 'elysia'

export const createUsersRoutes = (fetchFn: typeof fetch, database: typeof db) => {
  return new Elysia({ prefix: '/users' })
    .get('/', async () => {
      return await database.select().from(usersTable)
    })
    .post(
      '/',
      async ({ body }) => {
        const [user] = await database.insert(usersTable).values(body).returning()
        return user
      },
      {
        body: t.Object({
          name: t.String(),
          age: t.Integer(),
          email: t.String({ format: 'email' }),
        }),
      },
    )
}
