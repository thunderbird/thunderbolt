import { Button } from '@/components/ui/button'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { ShieldAlert } from 'lucide-react'

type InstallWarningDialogContentProps = {
  agentName: string
  onConfirm: () => void
  onCancel: () => void
}

export const InstallWarningDialogContent = ({ agentName, onConfirm, onCancel }: InstallWarningDialogContentProps) => (
  <ResponsiveModalContentComposable className="sm:max-w-md">
    <ResponsiveModalHeader>
      <ResponsiveModalTitle>Install {agentName}?</ResponsiveModalTitle>
      <ResponsiveModalDescription className="sr-only">
        Third-party agent installation warning
      </ResponsiveModalDescription>
    </ResponsiveModalHeader>
    <div className="flex flex-col gap-4 pt-2 pb-2">
      <div className="flex gap-3 rounded-xl border border-yellow-500/30 bg-yellow-500/5 px-4 py-3">
        <ShieldAlert className="size-5 text-yellow-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-yellow-700 dark:text-yellow-400">
          Third-party agents are not maintained by Thunderbolt and may introduce security or privacy risks. Use at your
          own risk.
        </p>
      </div>
    </div>
    <div className="flex justify-end gap-3 pt-2">
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button onClick={onConfirm}>Install Anyway</Button>
    </div>
  </ResponsiveModalContentComposable>
)
