/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowUp, ChevronRight, Folder, House, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useSshFolderPickerState } from './use-ssh-folder-picker-state'

/** Browse and filter remote folders without running shell commands or changing the selected folder until confirmed. */
export const SshFolderPicker = ({
  environmentId,
  value,
  onSelect,
  onClose,
}: {
  environmentId: string
  value: string
  onSelect: (path: string) => void
  onClose: () => void
}) => {
  const { t } = useLingui()
  const state = useSshFolderPickerState(environmentId, value)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[80dvh] flex-col">
        <DialogHeader>
          <DialogTitle>
            <Trans>Choose remote folder</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t`Parent folder`}
            disabled={!state.parentPath || state.loading}
            onClick={() => state.parentPath && state.navigate(state.parentPath)}
          >
            <ArrowUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t`Home folder`}
            disabled={!state.available || state.loading}
            onClick={() => state.navigate('~')}
          >
            <House className="size-4" />
          </Button>
          <span className="min-w-0 truncate text-sm text-muted-foreground" title={state.path}>
            {state.path}
          </span>
        </div>
        <Input
          value={state.filter}
          onChange={(event) => state.setFilter(event.target.value)}
          placeholder={t`Find a folder`}
          aria-label={t`Find a folder`}
          autoComplete="off"
        />
        <div className="min-h-48 flex-1 overflow-y-auto">
          {state.loading ? (
            <div role="status" className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin" aria-label={t`Loading folders…`} />
            </div>
          ) : !state.available ? (
            <p role="alert" className="py-4 text-sm text-muted-foreground">
              <Trans>This SSH environment is unavailable on this computer.</Trans>
            </p>
          ) : state.error ? (
            <div role="alert" className="space-y-3 py-4 text-sm">
              <p>
                <Trans>Could not load this folder.</Trans>
              </p>
              <p className="break-words text-xs text-muted-foreground">{String(state.error)}</p>
              <Button type="button" variant="outline" onClick={state.refresh}>
                <Trans>Try again</Trans>
              </Button>
            </div>
          ) : state.directories.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {state.filter ? <Trans>No matching folders.</Trans> : <Trans>No folders here.</Trans>}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {state.directories.map((directory) => (
                <Button
                  key={directory.path}
                  type="button"
                  variant="ghost"
                  className="justify-start gap-2"
                  onClick={() => state.navigate(directory.path)}
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">{directory.name}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Button>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="button" disabled={!state.canSelect} onClick={() => onSelect(state.path)}>
            <Trans>Choose folder</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
