import { useMCP } from '@/lib/mcp-provider'
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react'

/** Check if a connection error indicates an auth failure. Works with both current and future provider types. */
const isAuthError = (errorMessage: string | null | undefined) => {
  const msg = errorMessage?.toLowerCase() ?? ''
  return msg.includes('401') || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('auth')
}

export const MCPStatus = () => {
  const { servers } = useMCP()

  const connectedServers = servers.filter((s) => s.isConnected && s.enabled)
  const errorServers = servers.filter((s) => s.error && s.enabled)
  const connectingServers = servers.filter((s) => !s.isConnected && !s.error && s.enabled)

  // Transport type diversity display (populated once provider-integration wires transport info)
  const transportTypes = new Set(
    connectedServers
      .map((s) => (s as unknown as { transport?: { type?: string } }).transport?.type)
      .filter(Boolean),
  )
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
    // errorMessage is present after provider-integration; fall back to error.message
    const authErrors = errorServers.filter((s) => {
      const msg = (s as unknown as { errorMessage?: string | null }).errorMessage ?? s.error?.message
      return isAuthError(msg)
    })
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
