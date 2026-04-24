import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { useState } from 'react'

export type AddAgentParams =
  | { type: 'local'; name: string; command: string; args?: string[]; description?: string; apiKey?: string }
  | { type: 'remote'; name: string; url: string; description?: string; apiKey?: string }

type AddCustomAgentDialogProps = {
  onAdd: (params: AddAgentParams) => void
  onClose: () => void
  /** When true, only shows the remote agent form (for web/mobile) */
  remoteOnly?: boolean
}

export const AddCustomAgentDialogContent = ({ onAdd, onClose, remoteOnly }: AddCustomAgentDialogProps) => {
  const [agentType, setAgentType] = useState<'local' | 'remote'>(remoteOnly ? 'remote' : 'local')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [apiKey, setApiKey] = useState('')

  const canSubmit = agentType === 'local' ? name.trim() && command.trim() : name.trim() && url.trim()

  const handleSubmit = () => {
    if (!canSubmit) {
      return
    }

    if (agentType === 'local') {
      onAdd({
        type: 'local',
        name: name.trim(),
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : undefined,
        description: description.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      })
    } else {
      onAdd({
        type: 'remote',
        name: name.trim(),
        url: url.trim(),
        description: description.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      })
    }
  }

  return (
    <ResponsiveModalContentComposable className="sm:max-w-[500px]">
      <ResponsiveModalHeader>
        <ResponsiveModalTitle>Add Custom Agent</ResponsiveModalTitle>
        <ResponsiveModalDescription className="sr-only">Add a custom ACP agent</ResponsiveModalDescription>
      </ResponsiveModalHeader>
      <div className="grid gap-4 pt-4 pb-2">
        {!remoteOnly && (
          <div className="grid gap-2">
            <Label htmlFor="agent-type">Type</Label>
            <Select value={agentType} onValueChange={(v) => setAgentType(v as 'local' | 'remote')}>
              <SelectTrigger id="agent-type" className="rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="remote">Remote</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="grid gap-2">
          <Label htmlFor="agent-name">Name</Label>
          <Input id="agent-name" placeholder="My Agent" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        {agentType === 'local' ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="agent-command">Command</Label>
              <Input
                id="agent-command"
                placeholder="/usr/local/bin/my-agent or my-agent"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Path to the agent binary or command name on PATH</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-args">Arguments (optional)</Label>
              <Input
                id="agent-args"
                placeholder="--acp --verbose"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Space-separated arguments to pass to the agent</p>
            </div>
          </>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="agent-url">WebSocket URL</Label>
            <Input
              id="agent-url"
              placeholder="wss://example.com/agent/ws"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">WebSocket endpoint for the remote ACP agent</p>
          </div>
        )}

        <div className="grid gap-2">
          <Label htmlFor="agent-description">Description (optional)</Label>
          <Input
            id="agent-description"
            placeholder="A brief description of this agent"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="agent-api-key">API Key (optional)</Label>
          <Input
            id="agent-api-key"
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          Add Agent
        </Button>
      </div>
    </ResponsiveModalContentComposable>
  )
}
