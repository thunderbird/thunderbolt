import type { OAuth2Server } from 'oauth2-mock-server'

const globalTeardown = async () => {
  const server = (globalThis as Record<string, unknown>).__oidcServer as OAuth2Server | undefined
  if (server) {
    await server.stop()
    console.log('Mock OIDC server stopped')
  }
}

export default globalTeardown
