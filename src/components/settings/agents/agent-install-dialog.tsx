/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BookOpen } from 'lucide-react'
import { CopyCommandRow } from '@/components/settings/copy-command-row'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import type { AgentInstallMeta } from '@/defaults/agent-install-metadata'
import { buildRunCommand } from '@/lib/agent-install-command'
import { getPlatform } from '@/lib/platform'
import type { RegistryEntry } from '@/types/registry'

type AgentInstallDialogProps = {
  entry: RegistryEntry
  /** Extra setup detail the registry doesn't carry (API-key env vars, docs). When
   *  omitted, the dialog shows only the derived run command. */
  meta?: AgentInstallMeta
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Test/DI override for the runtime platform used to resolve a binary agent's
   *  command. Production omits and reads the real platform. */
  platform?: string
}

/** Setup instructions for a catalogue agent: the exact command to run it (with
 *  copy-to-clipboard), plus any authored API-key requirements and setup-doc link.
 *  These agents run on the user's own machine — this is the "how to run it" panel,
 *  not an in-app installer. */
export const AgentInstallDialog = ({ entry, meta, open, onOpenChange, platform }: AgentInstallDialogProps) => {
  const command = buildRunCommand(entry, platform ?? getPlatform())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContentComposable className="sm:max-w-[500px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Set up {entry.name}</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Run {entry.name} on your machine, then add it as a custom agent to connect.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>
        <div className="flex flex-col gap-4 pt-4 pb-2">
          {command && (
            <div className="grid grid-cols-1 gap-2">
              <p className="text-[length:var(--font-size-sm)] font-medium">Run this command</p>
              <CopyCommandRow command={command} label="Copy run command" />
            </div>
          )}
          {meta?.requiredEnv && meta.requiredEnv.length > 0 && (
            <div className="grid grid-cols-1 gap-2">
              <p className="text-[length:var(--font-size-sm)] font-medium">Required setup</p>
              <ul className="grid grid-cols-1 gap-2">
                {meta.requiredEnv.map((env) => (
                  <li key={env.name} className="text-[length:var(--font-size-xs)] text-muted-foreground">
                    <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground">{env.name}</code>{' '}
                    {env.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {meta?.setupNote && (
            <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{meta.setupNote}</p>
          )}
          {meta?.docsUrl && (
            <Button asChild variant="outline" size="sm" className="self-start">
              <a href={meta.docsUrl} target="_blank" rel="noopener noreferrer">
                <BookOpen />
                Setup guide
              </a>
            </Button>
          )}
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}
