/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Laptop, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { useSshDiscoveryState } from './use-ssh-discovery-state'

export const SshDiscoveryDialog = ({ onClose, onManual }: { onClose: () => void; onManual: () => void }) => {
  const { t } = useLingui()
  const state = useSshDiscoveryState(onClose)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add SSH connection</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Choose from your SSH configuration and local machines.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-64 flex-1 space-y-2 overflow-auto py-4">
          {state.loading && (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Looking for SSH hosts and local machines…</Trans>
            </p>
          )}
          {!state.loading && !state.options.length && !state.error && (
            <p className="text-sm text-muted-foreground">
              <Trans>No new SSH connections found. You can add one manually.</Trans>
            </p>
          )}
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              <Trans>Could not discover SSH connections. Try refreshing or add one manually.</Trans>
            </p>
          )}
          {state.options.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-center gap-3 rounded-xl border bg-muted/30 p-4 has-disabled:cursor-default has-disabled:opacity-50"
            >
              <Laptop className="size-5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.name}</span>
                <span className="text-xs text-muted-foreground">
                  {option.source === 'SSH config' ? <Trans>SSH config</Trans> : option.source}
                  {!option.host && (
                    <>
                      {' '}
                      · <Trans>Start this machine to connect</Trans>
                    </>
                  )}
                </span>
              </span>
              <Checkbox
                aria-label={option.name}
                checked={state.selected.includes(option.id)}
                disabled={!option.host || state.loading}
                onCheckedChange={() => state.toggle(option.id)}
              />
            </label>
          ))}
        </div>
        <DialogFooter className="flex-row items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Refresh SSH connections`}
              disabled={state.loading}
              onClick={state.refresh}
            >
              <RefreshCw className={state.loading ? 'animate-spin' : undefined} />
            </Button>
            <Button variant="ghost" onClick={onManual}>
              <Trans>Add manually</Trans>
            </Button>
          </div>
          <Button disabled={!state.canAdd || state.loading} onClick={state.add}>
            <Trans>Add</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
