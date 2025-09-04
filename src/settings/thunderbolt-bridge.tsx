import { settingsTable } from '@/db/tables'
import { DatabaseSingleton } from '@/db/singleton'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { eq } from 'drizzle-orm'
import { Loader2, Wifi, WifiOff } from 'lucide-react'
import { useState, useEffect } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { getBridgeSettings } from '@/lib/dal'

export default function ThunderboltBridgeSettingsPage() {
  const db = DatabaseSingleton.instance.db
  const queryClient = useQueryClient()
  const [isInitializing, setIsInitializing] = useState(false)
  const [bridgeEnabled, setBridgeEnabled] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<{
    websocket_server_initialized: boolean
    mcp_receiver_initialized: boolean
    thunderbird_connected: boolean
    bridge_ready: boolean
  } | null>(null)

  // Get bridge settings from database
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings', 'bridge_enabled'],
    queryFn: getBridgeSettings,
  })

  // Check bridge status periodically
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const status = await invoke<boolean>('get_bridge_status')
        setIsConnected(status)
        setBridgeEnabled(status)

        // Get detailed connection status
        const detailedStatus = await invoke<any>('get_bridge_connection_status')
        setConnectionStatus(detailedStatus)
      } catch (error) {
        console.error('Failed to get bridge status:', error)
        setIsConnected(false)
        setConnectionStatus(null)
      }
    }

    checkStatus()
    const interval = setInterval(checkStatus, 3000) // Check every 3 seconds

    return () => clearInterval(interval)
  }, [])

  // Initialize bridge when settings load
  useEffect(() => {
    const initBridge = async () => {
      if (settings && !isInitializing) {
        setIsInitializing(true)
        try {
          // Initialize the bridge
          await invoke('init_bridge')

          // Set enabled state based on saved settings
          if (settings.enabled) {
            await invoke('set_bridge_enabled', { enabled: true })
            setBridgeEnabled(true)
          }
        } catch (error) {
          console.error('Failed to initialize bridge:', error)
        } finally {
          setIsInitializing(false)
        }
      }
    }

    initBridge()
  }, [settings])

  // Save bridge enabled state
  const saveBridgeMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      // Update in Tauri
      await invoke('set_bridge_enabled', { enabled })

      // Save to database
      await db.delete(settingsTable).where(eq(settingsTable.key, 'bridge_enabled'))
      await db.insert(settingsTable).values([{ key: 'bridge_enabled', value: enabled.toString() }])

      return enabled
    },
    onSuccess: (enabled) => {
      setBridgeEnabled(enabled)
      queryClient.invalidateQueries({ queryKey: ['settings', 'bridge_enabled'] })
    },
  })

  const handleToggleBridge = async (checked: boolean) => {
    await saveBridgeMutation.mutateAsync(checked)
  }

  if (isLoading || isInitializing) {
    return (
      <div className="flex flex-col gap-4 p-4 w-full max-w-[760px] mx-auto">
        <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Thunderbolt Bridge</h1>
        <div className="flex items-center justify-center p-8">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 w-full max-w-[760px] mx-auto">
      <h1 className="mt-8 text-4xl font-bold tracking-tight mb-2 text-primary">Thunderbolt Bridge</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {isConnected ? (
              <Wifi className="h-5 w-5 text-green-500" />
            ) : (
              <WifiOff className="h-5 w-5 text-muted-foreground" />
            )}
            Bridge Status
          </CardTitle>
          <CardDescription>Connect Thunderbird to AI assistants through the Thunderbolt Bridge</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between space-x-2">
            <Label htmlFor="bridge-toggle" className="flex flex-col space-y-1">
              <span>Enable Bridge</span>
              <span className="font-normal text-sm text-muted-foreground">
                Allow AI assistants to access your Thunderbird data
              </span>
            </Label>
            <Switch
              id="bridge-toggle"
              checked={bridgeEnabled}
              onCheckedChange={handleToggleBridge}
              disabled={saveBridgeMutation.isPending}
            />
          </div>

          {bridgeEnabled && (
            <Alert>
              <AlertTitle>Connection Details</AlertTitle>
              <AlertDescription className="space-y-2 mt-2">
                <div>
                  <strong>Bridge Status:</strong> {isConnected ? 'Enabled' : 'Disabled'}
                </div>
                {connectionStatus && (
                  <>
                    <div>
                      <strong>WebSocket Server:</strong>{' '}
                      {connectionStatus.websocket_server_initialized ? '✅ Running' : '❌ Not started'}
                    </div>
                    <div>
                      <strong>MCP Server:</strong>{' '}
                      {connectionStatus.mcp_receiver_initialized ? '✅ Running' : '❌ Not started'}
                    </div>
                    <div>
                      <strong>Thunderbird Connection:</strong>{' '}
                      {connectionStatus.thunderbird_connected ? '✅ Connected' : '❌ Not connected'}
                    </div>
                    <div>
                      <strong>Overall Status:</strong> {connectionStatus.bridge_ready ? '✅ Ready' : '❌ Not ready'}
                    </div>
                  </>
                )}
                <div>
                  <strong>WebSocket:</strong> ws://localhost:9001
                </div>
                <div>
                  <strong>MCP Server:</strong> http://localhost:9002/mcp/
                </div>
              </AlertDescription>
            </Alert>
          )}

          {bridgeEnabled && !isConnected && (
            <Alert>
              <AlertTitle>Setup Instructions</AlertTitle>
              <AlertDescription className="space-y-2 mt-2">
                <ol className="list-decimal list-inside space-y-1">
                  <li>Install the Thunderbolt Bridge extension in Thunderbird</li>
                  <li>Open the extension popup and enable the bridge</li>
                  <li>The connection will be established automatically</li>
                </ol>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security Notice</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            When the bridge is enabled, AI assistants can access your emails, contacts, and other Thunderbird data. Only
            enable this feature if you trust the AI services you're using.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Thunderbird Extension</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            To use the Thunderbolt Bridge, you need to install the companion extension in Thunderbird.
          </p>
          <Button
            variant="outline"
            onClick={async () => {
              // Open the bridge directory in file explorer
              await open('bridge')
            }}
          >
            Open Extension Folder
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
