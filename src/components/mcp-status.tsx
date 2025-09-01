import { useMCP } from '@/lib/mcp-provider'
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react'

export function MCPStatus() {
  const { servers } = useMCP()

  const connectedServers = servers.filter((s) => s.isConnected && s.enabled)
  const errorServers = servers.filter((s) => s.error && s.enabled)
  const connectingServers = servers.filter((s) => !s.isConnected && !s.error && s.enabled)

  if (connectedServers.length > 0 && errorServers.length === 0) {
    return (
      <div className="flex items-center gap-2 text-green-600">
        <CheckCircle className="h-4 w-4" />
        <span className="text-sm">MCP Connected ({connectedServers.length})</span>
      </div>
    )
  }

  if (errorServers.length > 0) {
    return (
      <div className="flex items-center gap-2 text-red-600">
        <XCircle className="h-4 w-4" />
        <span className="text-sm">MCP Error ({errorServers.length})</span>
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
