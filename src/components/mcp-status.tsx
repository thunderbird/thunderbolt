import { useMCP } from '@/lib/mcp-provider'
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react'

/** Check if a connection error indicates an auth failure. */
const isAuthError = (errorMessage: string | null | undefined) => {
  const msg = errorMessage?.toLowerCase() ?? ''
  return msg.includes('401') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('auth')
}

export const MCPStatus = () => {
  const { servers } = useMCP()

  const connectedServers = servers.filter((s) => s.isConnected && s.enabled)
  const errorServers = servers.filter((s) => s.error && s.enabled)
  const connectingServers = servers.filter((s) => !s.isConnected && !s.error && s.enabled)

  const transportTypes = new Set(connectedServers.map((s) => s.transport.type))
  const showTransports = transportTypes.size > 1

  if (connectedServers.length > 0 && errorServers.length === 0) {
    const transportSuffix = showTransports ? ` · ${[...transportTypes].join(', ')}` : ''
    return (
      <div className="flex items-center gap-2 text-green-600">
        <CheckCircle className="h-4 w-4" />
        <span className="text-sm">
          MCP Connected ({connectedServers.length}){transportSuffix}
        </span>
      </div>
    )
  }

  if (errorServers.length > 0) {
    const authErrors = errorServers.filter((s) => isAuthError(s.errorMessage ?? s.error?.message))
    const hasAuthError = authErrors.length > 0

    return (
      <div className="flex items-center gap-2 text-red-600">
        <XCircle className="h-4 w-4" />
        <span className="text-sm">
          {hasAuthError ? `MCP Auth Error (${authErrors.length})` : `MCP Error (${errorServers.length})`}
        </span>
      </div>
    )
  }

  if (connectingServers.length > 0) {
    return (
      <div className="flex items-center gap-2 text-yellow-600">
        <AlertCircle className="h-4 w-4" />
        <span className="text-sm">MCP Connecting...</span>
      </div>
    )
  }

  return null
}
