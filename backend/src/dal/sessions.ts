import type { db as DbType } from '@/db/client'
import { session } from '@/db/auth-schema'
import { and, eq, gt } from 'drizzle-orm'

/** Get an active (non-expired) session by bearer token. Returns null if not found or expired. */
export const getActiveSessionByToken = async (database: typeof DbType, token: string) =>
  database
    .select({ userId: session.userId })
    .from(session)
    .where(and(eq(session.token, token), gt(session.expiresAt, new Date())))
    .limit(1)
    .then((rows) => rows[0] ?? null)
