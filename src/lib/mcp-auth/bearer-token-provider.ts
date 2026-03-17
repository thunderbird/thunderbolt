import type { CredentialStore } from '@/types/mcp'

/**
 * Creates HTTP Authorization headers for bearer token authentication.
 * Used to inject auth into Streamable HTTP and SSE transport requests.
 */
const createBearerAuthHeaders = (token: string): HeadersInit => ({
  Authorization: `Bearer ${token}`,
})

/**
 * Retrieves the decrypted API key for a server and returns it as environment
 * variables to pass to a stdio child process.
 *
 * Passes secrets via environment variables (not CLI args) per the MCP spec
 * recommendation and to avoid leaking credentials in the process list (threat T9).
 */
const getEnvVarsForStdio = async (
  credentialStore: CredentialStore,
  serverId: string,
): Promise<Record<string, string>> => {
  const cred = await credentialStore.load(serverId)
  if (!cred || cred.type !== 'bearer') return {}
  return { MCP_API_KEY: cred.token }
}

export { createBearerAuthHeaders, getEnvVarsForStdio }
