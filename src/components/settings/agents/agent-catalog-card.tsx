/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Code2, ExternalLink, Plug, Terminal } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { distributionLabel, primaryDistributionKind } from '@/lib/agent-registry-filter'
import type { RegistryEntry } from '@/types/registry'
import { BridgeConnectDialog } from './bridge-connect-dialog'

type AgentCatalogCardProps = {
  entry: RegistryEntry
  /** Hands off to the existing Add Custom Agent flow from the bridge dialog. */
  onAddCustomAgent: () => void
}

/** A catalogue card for a "bridge" agent: shows the agent's identity and
 *  metadata, links out to its website and source, and offers a "Connect via
 *  bridge" action that walks the user through running the CLI locally and
 *  bridging it into Thunderbolt over a localhost WebSocket. */
export const AgentCatalogCard = ({ entry, onAddCustomAgent }: AgentCatalogCardProps) => {
  const [iconFailed, setIconFailed] = useState(false)
  const [bridgeOpen, setBridgeOpen] = useState(false)

  const distributionKind = primaryDistributionKind(entry)
  const websiteUrl = entry.website ?? entry.repository
  const sourceUrl = entry.repository && entry.repository !== websiteUrl ? entry.repository : null
  const showIcon = entry.icon && !iconFailed
  const metadata = [entry.version ? `v${entry.version}` : null, entry.authors.join(', ') || null, entry.license || null]
    .filter(Boolean)
    .join(' · ')

  return (
    <Card data-testid={`agent-catalog-card-${entry.id}`} className="border border-border gap-3 py-4">
      <CardHeader className="px-4">
        <div className="flex items-center gap-3 min-w-0">
          {showIcon ? (
            <img
              src={entry.icon}
              alt=""
              className="size-8 rounded-md shrink-0"
              draggable={false}
              onError={() => setIconFailed(true)}
            />
          ) : (
            <Terminal className="size-8 text-muted-foreground shrink-0" aria-hidden="true" />
          )}
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium truncate">{entry.name}</span>
            {distributionKind && (
              <span className="text-[length:var(--font-size-xs)] text-muted-foreground rounded-md border border-border px-2 py-0.5 shrink-0">
                {distributionLabel(distributionKind)}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 flex flex-col gap-3">
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground">{entry.description}</p>
        <p className="text-[length:var(--font-size-xs)] text-muted-foreground">{metadata}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setBridgeOpen(true)}>
            <Plug />
            Connect via bridge
          </Button>
          {websiteUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={websiteUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                Website
              </a>
            </Button>
          )}
          {sourceUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                <Code2 />
                Source
              </a>
            </Button>
          )}
        </div>
      </CardContent>
      <BridgeConnectDialog
        entry={entry}
        open={bridgeOpen}
        onOpenChange={setBridgeOpen}
        onAddCustomAgent={onAddCustomAgent}
      />
    </Card>
  )
}
