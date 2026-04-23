import type { Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia } from 'elysia'

export const createConfigRoutes = (settings: Settings) =>
  new Elysia({ prefix: '/config' }).onError(safeErrorHandler).get('/', () => ({
    e2eeEnabled: settings.e2eeEnabled,
  }))
