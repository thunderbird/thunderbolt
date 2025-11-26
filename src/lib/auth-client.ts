import { magicLinkClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * Get the auth base URL from environment or default
 * The backend auth routes are mounted at /v1/api/auth/*
 */
const getAuthBaseURL = () => {
  const cloudUrl = import.meta.env.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000/v1'
  // Remove trailing /v1 if present since Better Auth adds /api/auth
  return cloudUrl.replace(/\/v1$/, '')
}

/**
 * Better Auth client for frontend authentication
 * Configured with magic link plugin for email-based passwordless auth
 */
export const authClient = createAuthClient({
  baseURL: getAuthBaseURL(),
  basePath: '/v1/api/auth',
  plugins: [magicLinkClient()],
})

export type Session = typeof authClient.$Infer.Session
export type User = Session['user']
