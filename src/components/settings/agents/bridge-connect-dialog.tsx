/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Code2, ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { composeBridgeCommand, composeInstallCommand } from '@/lib/agent-bridge-command'
import type { RegistryEntry } from '@/types/registry'
import { CopyableCommand } from './copyable-command'

type BridgeConnectDialogProps = {
  entry: RegistryEntry
  open: boolean
  onOpenChange: (open: boolean) => void
}

type StepProps = {
  index: number
  title: string
  children: ReactNode
}

/** A numbered step with a title and body. */
const Step = ({ index, title, children }: StepProps) => (
  <div className="flex gap-3">
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[length:var(--font-size-xs)] font-medium">
      {index}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <p className="text-[length:var(--font-size-sm)] font-medium">{title}</p>
      {children}
    </div>
  </div>
)

/** Body for binary-only agents: no portable launch command, so we point the
 *  user at the agent's own docs to install and run it, then connect manually. */
const BinaryFallback = ({ entry }: { entry: RegistryEntry }) => {
  const docsUrl = entry.website ?? entry.repository
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        {entry.name} ships as a platform binary, so there's no one-line command to wrap. Install it from the agent's own
        instructions, run it with the bridge, then add it as a custom agent using the{' '}
        <code className="font-mono text-[length:var(--font-size-xs)]">ws://127.0.0.1:PORT</code> address the bridge
        prints.
      </p>
      {docsUrl && (
        <Button asChild variant="outline" size="sm" className="self-start">
          <a href={docsUrl} target="_blank" rel="noopener noreferrer">
            <Code2 />
            Agent instructions
            <ExternalLink />
          </a>
        </Button>
      )}
    </div>
  )
}

/**
 * Walks the user through connecting a catalogue agent via the local
 * `thunderbolt-stdio-bridge`: install the bridge, run it wrapping the agent's
 * CLI, then add the loopback URL it prints as a custom agent. Binary-only agents
 * have no composable launch, so the dialog renders a fallback that points at the
 * agent's own docs instead.
 */
export const BridgeConnectDialog = ({ entry, open, onOpenChange }: BridgeConnectDialogProps) => {
  const bridgeCommand = composeBridgeCommand(entry)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContentComposable className="sm:max-w-[560px]" data-testid="bridge-connect-dialog">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Connect {entry.name} via bridge</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            {entry.name} runs on your machine. The bridge exposes it to Thunderbolt over a local WebSocket.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>
        {bridgeCommand ? (
          <div className="flex flex-col gap-5 pt-2">
            <Step index={1} title="Install the bridge (once)">
              <CopyableCommand command={composeInstallCommand()} testId="install" />
            </Step>
            <Step index={2} title="Run the bridge">
              <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
                It prints a <code className="font-mono text-[length:var(--font-size-xs)]">ws://127.0.0.1:PORT</code>{' '}
                address and stays running.
              </p>
              <CopyableCommand command={bridgeCommand} testId="run" />
            </Step>
            <Step index={3} title="Add the agent">
              <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
                Use "Add custom agent" and paste the printed address as the URL.
              </p>
            </Step>
          </div>
        ) : (
          <div className="pt-2">
            <BinaryFallback entry={entry} />
          </div>
        )}
        <div className="flex justify-end pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
