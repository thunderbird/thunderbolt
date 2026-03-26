import { Button } from '@/components/ui/button'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isDesktop } from '@/lib/platform'
import type { McpTransportType, McpAuthType, McpServerFormState, McpServerFormAction } from '@/types/mcp'
import { Check, Eye, EyeOff, X } from 'lucide-react'
import { useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

type AddMcpServerDialogProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  formState: McpServerFormState
  formDispatch: (action: McpServerFormAction) => void
  onTestConnection: () => void
  onAddServer: () => void
  onUrlKeyDown: (e: KeyboardEvent) => void
  onArgsInput: (value: string) => void
  canTestConnection: boolean
  canAddServer: boolean
  isValid: () => boolean
  trigger: ReactNode
}

export const AddMcpServerDialog = ({
  isOpen,
  onOpenChange,
  formState,
  formDispatch,
  onTestConnection,
  onAddServer,
  onUrlKeyDown,
  onArgsInput,
  canTestConnection,
  canAddServer,
  isValid,
  trigger,
}: AddMcpServerDialogProps) => {
  const [showToken, setShowToken] = useState(false)

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <ResponsiveModalContentComposable className="sm:max-w-[500px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Add MCP Server</ResponsiveModalTitle>
          <ResponsiveModalDescription>Configure the MCP server connection.</ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="transport-type">Transport</Label>
            <Select
              value={formState.transportType}
              onValueChange={(value) =>
                formDispatch({ type: 'SET_TRANSPORT_TYPE', payload: value as McpTransportType })
              }
            >
              <SelectTrigger id="transport-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP (Streamable)</SelectItem>
                <SelectItem value="sse">SSE (Legacy)</SelectItem>
                <SelectItem value="stdio" disabled={!isDesktop()}>
                  stdio (Local){!isDesktop() && ' — desktop app only'}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {formState.transportType !== 'stdio' && (
            <div className="grid gap-2">
              <Label htmlFor="url">Server URL</Label>
              <Input
                id="url"
                placeholder="http://localhost:8000/mcp/"
                value={formState.url}
                onChange={(e) => formDispatch({ type: 'SET_URL', payload: e.target.value })}
                onKeyDown={onUrlKeyDown}
              />
            </div>
          )}

          {formState.transportType === 'stdio' && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="command">Command</Label>
                <Input
                  id="command"
                  placeholder="npx"
                  value={formState.command}
                  onChange={(e) => formDispatch({ type: 'SET_COMMAND', payload: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="args">Arguments (space-separated)</Label>
                <Input
                  id="args"
                  placeholder="mcp-server --port 8080"
                  value={formState.args.join(' ')}
                  onChange={(e) => onArgsInput(e.target.value)}
                />
              </div>
            </>
          )}

          <div className="grid gap-2">
            <Label htmlFor="auth-type">Authentication</Label>
            <Select
              value={formState.authType}
              onValueChange={(value) => formDispatch({ type: 'SET_AUTH_TYPE', payload: value as McpAuthType })}
            >
              <SelectTrigger id="auth-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="bearer">API Key / Bearer Token</SelectItem>
                <SelectItem value="oauth">OAuth 2.1</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {formState.authType === 'bearer' && (
            <div className="grid gap-2">
              <Label htmlFor="bearer-token">API Key / Bearer Token</Label>
              <div className="relative">
                <Input
                  id="bearer-token"
                  type={showToken ? 'text' : 'password'}
                  autoComplete="off"
                  placeholder="Enter API key or bearer token"
                  value={formState.bearerToken}
                  onChange={(e) => formDispatch({ type: 'SET_BEARER_TOKEN', payload: e.target.value })}
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 text-muted-foreground"
                  onClick={() => setShowToken((prev) => !prev)}
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}

          {formState.authType === 'oauth' && (
            <div className="grid gap-2">
              <Button variant="outline" className="w-full" disabled>
                Connect with OAuth
                <span className="ml-2 text-xs text-muted-foreground">(coming soon)</span>
              </Button>
            </div>
          )}

          {formState.transportType !== 'stdio' && isValid() && (
            <Button onClick={onTestConnection} disabled={!canTestConnection} variant="outline" className="w-full">
              {formState.connectionStatus === 'testing' ? 'Testing Connection...' : 'Test Connection'}
            </Button>
          )}

          {formState.connectionStatus === 'success' && (
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center gap-2 text-green-800">
                <Check className="h-4 w-4" />
                <span className="font-medium">Connection successful!</span>
              </div>
              {formState.serverCapabilities.length > 0 && (
                <div className="mt-3">
                  <p className="text-sm text-green-700 font-medium">Available tools:</p>
                  <ul className="text-sm text-green-600 mt-1 space-y-1">
                    {formState.serverCapabilities.map((capability, index) => (
                      <li key={index} className="flex items-center gap-2">
                        <div className="w-1 h-1 bg-green-600 rounded-full" />
                        {capability}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {formState.connectionStatus === 'error' && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-center gap-2 text-red-800">
                <X className="h-4 w-4" />
                <span className="font-medium">Connection failed</span>
              </div>
              <p className="text-sm text-red-600 mt-1">
                {formState.connectionError ??
                  'Could not connect to the MCP server. Please check the URL and try again.'}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onAddServer} disabled={!canAddServer}>
            Add Server
          </Button>
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
