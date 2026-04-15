import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia } from 'elysia'

export const createConfigRoutes = () => new Elysia({ prefix: '/config' }).onError(safeErrorHandler).get('/', () => ({}))
