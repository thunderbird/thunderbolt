/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ArrowRight, ExternalLink } from 'lucide-react'
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
  /** Hands off to the existing Add Custom Agent flow so the user can paste the
   *  `ws://127.0.0.1:PORT` URL the bridge prints. */
  onAddCustomAgent: () => void
}

/** Walks the user through running a CLI agent locally and bridging it into
 *  Thunderbolt: install the agent, run `acp-bridge`, then add the printed
 *  localhost URL as a custom agent. All commands are derived from the registry
 *  distribution at render — no effects, no local state. */
export const BridgeConnectDialog = ({ entry, open, onOpenChange, onAddCustomAgent }: BridgeConnectDialogProps) => {
  const installCommand = composeInstallCommand(entry)
  const bridgeCommand = composeBridgeCommand(entry)
  // `binary` distributions have no portable launch line — both commands are
  // null together, so we fall back to pointing the user at the agent's site.
  const siteUrl = entry.website ?? entry.repository ?? null

  const handleAddCustomAgent = () => {
    onOpenChange(false)
    onAddCustomAgent()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContentComposable className="sm:max-w-[520px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Connect {entry.name} via bridge</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Run this CLI agent on your machine and bridge it into Thunderbolt over a local WebSocket.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <div className="grid gap-5 pt-4 pb-2">
          {installCommand && bridgeCommand ? (
            <>
              <div className="grid gap-2">
                <p className="text-[length:var(--font-size-sm)] font-medium">1. Install the agent</p>
                <CopyableCommand command={installCommand} />
              </div>
              <div className="grid gap-2">
                <p className="text-[length:var(--font-size-sm)] font-medium">2. Run the bridge</p>
                <CopyableCommand command={bridgeCommand} />
                <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                  The bridge prints a <code className="font-mono">ws://127.0.0.1:PORT</code> URL once it's running.
                </p>
              </div>
              <div className="grid gap-2">
                <p className="text-[length:var(--font-size-sm)] font-medium">3. Add the agent</p>
                <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
                  Paste the printed URL into Add Custom Agent to connect.
                </p>
              </div>
            </>
          ) : (
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              {entry.name} ships as a platform binary. Follow its install instructions, then run it under{' '}
              <code className="font-mono">acp-bridge</code> and add the printed{' '}
              <code className="font-mono">ws://127.0.0.1:PORT</code> URL.
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-3 pt-2">
          {siteUrl && (
            <Button asChild variant="ghost">
              <a href={siteUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                Agent site
              </a>
            </Button>
          )}
          <Button onClick={handleAddCustomAgent}>
            Add the agent
            <ArrowRight />
          </Button>
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
