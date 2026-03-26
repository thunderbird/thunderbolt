import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { createMCPClient } from '@ai-sdk/mcp'

/** MCP client instance from the AI SDK */
type McpClient = Awaited<ReturnType<typeof createMCPClient>>

/** Configuration for creating an MCP transport */
type McpTransportConfig = { type: 'http' | 'sse'; url: string } | { type: 'stdio'; command: string; args?: string[] }

/** Transport types supported by the app */
type McpTransportType = McpTransportConfig['type']

/** Authentication types supported by the app */
type McpAuthType = 'none' | 'bearer' | 'oauth'

/** Configuration for MCP authentication */
type McpAuthConfig = {
  authType: McpAuthType
  /** Credential key reference for secure storage lookup */
  credentialKey?: string
  /** OAuth account ID for oauth auth type */
  oauthAccountId?: string
}

/** Full server configuration passed through the system */
type McpServerConfig = {
  id: string
  name: string
  enabled: boolean
  transport: McpTransportConfig
  auth: McpAuthConfig
}

/** Extended connection state for the provider */
type McpServerConnection = {
  id: string
  name: string
  transport: McpTransportConfig
  auth: McpAuthConfig
  client: McpClient | null
  isConnected: boolean
  error: Error | null
  errorMessage: string | null
  enabled: boolean
}

/** Result of creating a transport (transport + optional auth provider) */
type McpTransportResult = {
  transport: Transport
  authProvider?: OAuthClientProvider
}

/** Credential data stored in secure storage */
type McpCredential =
  | {
      type: 'bearer'
      token: string
    }
  | {
      type: 'oauth'
      accessToken: string
      refreshToken?: string
      expiresAt?: string
      tokenType: string
      scope?: string
    }

/** Encryption/decryption interface for credential store */
type CredentialStore = {
  save: (serverId: string, credential: McpCredential) => Promise<void>
  load: (serverId: string) => Promise<McpCredential | null>
  delete: (serverId: string) => Promise<void>
}

/** Form state for the add/edit server dialog */
type McpServerFormState = {
  transportType: McpTransportType
  url: string
  command: string
  args: string[]
  authType: McpAuthType
  bearerToken: string
  connectionStatus: 'idle' | 'testing' | 'success' | 'error'
  connectionError: string | null
  serverCapabilities: string[]
}

type McpServerFormAction =
  | { type: 'SET_TRANSPORT_TYPE'; payload: McpTransportType }
  | { type: 'SET_URL'; payload: string }
  | { type: 'SET_COMMAND'; payload: string }
  | { type: 'SET_ARGS'; payload: string[] }
  | { type: 'SET_AUTH_TYPE'; payload: McpAuthType }
  | { type: 'SET_BEARER_TOKEN'; payload: string }
  | { type: 'SET_CONNECTION_STATUS'; payload: McpServerFormState['connectionStatus'] }
  | { type: 'SET_CONNECTION_ERROR'; payload: string | null }
  | { type: 'SET_CAPABILITIES'; payload: string[] }
  | { type: 'RESET' }

export type {
  McpClient,
  McpTransportType,
  McpAuthType,
  McpTransportConfig,
  McpAuthConfig,
  McpServerConfig,
  McpServerConnection,
  McpTransportResult,
  McpCredential,
  CredentialStore,
  McpServerFormState,
  McpServerFormAction,
}
