export type RemoteAgentDescriptor = {
  id: string
  name: string
  type: 'remote'
  transport: 'websocket'
  url: string
  icon: string
  isSystem: number
  enabled: number
}
