/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared iroh pairing UI — the one panel both the ACP custom-agent dialog and the
 * MCP add-server form render when the user targets an iroh bridge. The bridge
 * allowlists peers by NodeId, so a connection only succeeds after the user
 * authorizes THIS app's NodeId on the host (`thunderbolt iroh allow <id>`). The
 * panel renders that one-liner with a copy button, plus the load/error state of
 * fetching this app's identity.
 */

import { Check, Copy, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { irohClientNodeId } from '@/acp/iroh/iroh-transport'
import { Button } from '@/components/ui/button'

/** Load state for this app's own iroh NodeId, shown so the user can authorize it
 *  on their bridge before the first dial. */
export type AppNodeIdState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; nodeId: string }
  | { status: 'error'; error: string }

/**
 * Loads this app's iroh NodeId while `enabled` (i.e. the user is targeting an
 * iroh bridge), so it can be shown for allowlisting. The load is an external
 * async read from the wasm client — gating it on `enabled` keeps the multi-MB
 * wasm chunk lazy: it never runs for the WebSocket/http flow or before an iroh
 * target is entered. Flipping `enabled` back to false resets to idle, so a later
 * re-enable (reopen the dialog, re-enter a target) reloads a fresh identity
 * rather than stranding on a stale "Loading".
 *
 * @param enabled Whether an iroh target is currently selected.
 * @param load Test/DI seam for reading the NodeId; production lazy-loads the wasm.
 */
export const useAppNodeId = (enabled: boolean, load: () => Promise<string> = irohClientNodeId): AppNodeIdState => {
  const [state, setState] = useState<AppNodeIdState>({ status: 'idle' })
  // Read `load` through a ref so the effect fires once per idle→loaded cycle
  // keyed on `enabled` alone — an unstable `load` (e.g. an inline arrow) must not
  // re-trigger the fetch on every render.
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    loadRef
      .current()
      .then((nodeId) => !cancelled && setState({ status: 'ready', nodeId }))
      .catch(
        (err) => !cancelled && setState({ status: 'error', error: err instanceof Error ? err.message : String(err) }),
      )
    return () => {
      cancelled = true
    }
  }, [enabled])
  return state
}

/** Renders the `thunderbolt iroh allow <node-id>` one-liner with a copy button,
 *  or the load/error state of fetching this app's pairing identity. */
export const IrohPairingPanel = ({
  appNodeId,
  copy,
  isCopied,
}: {
  appNodeId: AppNodeIdState
  copy: (text: string) => Promise<void>
  isCopied: boolean
}) => (
  <div className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3" data-testid="iroh-pairing-panel">
    <p className="text-[length:var(--font-size-sm)] font-medium">Authorize this app on your bridge</p>
    <p className="text-[length:var(--font-size-xs)] text-muted-foreground">
      Run this on the machine hosting the bridge, then add it — the connection is verified on first use.
    </p>
    {appNodeId.status === 'ready' ? (
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-[length:var(--font-size-xs)]">
          thunderbolt iroh allow {appNodeId.nodeId}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="size-8 shrink-0 p-0"
          aria-label="Copy allow command"
          onClick={() => void copy(`thunderbolt iroh allow ${appNodeId.nodeId}`)}
        >
          {isCopied ? <Check className="size-4 text-green-600" /> : <Copy className="size-4" />}
        </Button>
      </div>
    ) : appNodeId.status === 'error' ? (
      <p className="text-[length:var(--font-size-xs)] text-destructive">
        Couldn&apos;t load this app&apos;s pairing identity: {appNodeId.error}
      </p>
    ) : (
      <span className="flex items-center gap-2 text-[length:var(--font-size-xs)] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading this app&apos;s pairing identity…
      </span>
    )}
  </div>
)
