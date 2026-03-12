import { KeyRound, KeySquare } from 'lucide-react'

type ChooseMethodStepProps = {
  onSelect: (method: 'create' | 'import-passphrase') => void
}

const methods = [
  {
    id: 'create' as const,
    icon: KeyRound,
    title: 'Create a new encryption key',
    description: 'Generate a new key for this account. Best for first-time setup.',
  },
  {
    id: 'import-passphrase' as const,
    icon: KeySquare,
    title: 'Import via passphrase',
    description: 'Re-derive your key using a passphrase from another device.',
  },
]

export const ChooseMethodStep = ({ onSelect }: ChooseMethodStepProps) => (
  <div className="flex flex-col gap-3">
    <p className="text-sm text-muted-foreground mb-2">
      To enable sync, you need an encryption key. Choose how to set it up:
    </p>
    {methods.map(({ id, icon: Icon, title, description }) => (
      <button
        key={id}
        type="button"
        onClick={() => onSelect(id)}
        className="flex items-start gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-accent cursor-pointer"
      >
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-sm text-muted-foreground mt-0.5">{description}</div>
        </div>
      </button>
    ))}
  </div>
)
