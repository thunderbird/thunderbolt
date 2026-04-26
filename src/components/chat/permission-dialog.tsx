import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { Button } from '@/components/ui/button'
import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'

type PermissionDialogProps = {
  request: RequestPermissionRequest
  onRespond: (response: RequestPermissionResponse) => void
}

const toolKindLabel = (kind?: string | null) => {
  switch (kind) {
    case 'edit':
      return 'Edit file'
    case 'delete':
      return 'Delete'
    case 'execute':
      return 'Run command'
    case 'move':
      return 'Move file'
    default:
      return 'Action'
  }
}

const optionVariant = (kind: PermissionOption['kind']): 'default' | 'destructive' | 'outline' | 'secondary' => {
  switch (kind) {
    case 'allow_once':
      return 'default'
    case 'allow_always':
      return 'secondary'
    case 'reject_once':
      return 'outline'
    case 'reject_always':
      return 'destructive'
  }
}

export const PermissionDialog = ({ request, onRespond }: PermissionDialogProps) => {
  const [responded, setResponded] = useState(false)

  const toolCall = request.toolCall
  const title = toolCall?.title ?? 'Permission Required'
  const kind = toolCall?.kind

  const handleSelect = (option: PermissionOption) => {
    if (responded) {
      return
    }
    setResponded(true)
    onRespond({
      outcome: { outcome: 'selected', optionId: option.optionId },
    })
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 my-2">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-amber-500" />
        <span className="font-medium text-[length:var(--font-size-body)]">{toolKindLabel(kind)}</span>
      </div>

      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{title}</p>

      {toolCall?.locations && toolCall.locations.length > 0 && (
        <div className="text-[length:var(--font-size-xs)] text-muted-foreground font-mono">
          {toolCall.locations.map((loc, i) => (
            <div key={i}>
              {loc.path}
              {loc.line != null && `:${loc.line}`}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            variant={optionVariant(option.kind)}
            size="sm"
            disabled={responded}
            onClick={() => handleSelect(option)}
          >
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  )
}
