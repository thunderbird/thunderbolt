/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Check, Copy, SquarePen, Sparkles } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { FormFooter } from '@/components/ui/form-footer'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { canCompactMemories } from '@/memory/compact'
import { maxMemoryBytes } from '@/memory/limits'
import { MemoryDocument } from './memory-document'
import { useMemorySettingsState } from './use-memory-settings-state'

type MemoryDocumentPanelProps = {
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
  initialEditContent?: string
}

/** View and edit built-in memory in the same route-preserving surface as connected providers. */
export const MemoryDocumentPanel = ({
  open,
  onClose,
  onCloseComplete,
  initialEditContent,
}: MemoryDocumentPanelProps) => {
  const { t } = useLingui()
  const page = useMemorySettingsState({ initialEditContent })
  const disabled = !page.memoryEnabled.value || page.memoryEnabled.isLoading
  const full = page.usage.bytes > maxMemoryBytes
  const close = () => {
    if (!page.pending) {
      onClose()
    }
  }
  return (
    <>
      <DetailPanelSurface open={open} onClose={close} onCloseComplete={onCloseComplete} topInset>
        <DetailPanel
          title={t`Built-in memory`}
          icon={<AppLogo size={24} alt="" />}
          onClose={close}
          bodyLayout="fill"
          actions={
            <DetailActionsMenu>
              <DropdownMenuItem
                onClick={page.startEditing}
                disabled={disabled || page.pending || page.isLoading || !!page.edit}
                className="cursor-pointer"
              >
                <SquarePen />
                <Trans>Edit</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={page.compact}
                aria-busy={page.compacting}
                disabled={
                  disabled ||
                  page.pending ||
                  page.isLoading ||
                  !!page.edit ||
                  !page.model ||
                  !canCompactMemories(page.content)
                }
                className="cursor-pointer"
              >
                <Sparkles />
                {page.compacting ? <Trans>Compacting…</Trans> : <Trans>Compact</Trans>}
              </DropdownMenuItem>
            </DetailActionsMenu>
          }
        >
          <fieldset disabled={disabled} className="flex min-h-0 flex-1 flex-col gap-4 disabled:opacity-50">
            {page.edit ? (
              <Textarea
                aria-label={t`Memory text`}
                aria-describedby="memory-size"
                placeholder={t`Add things you want your agent to remember.`}
                value={page.text}
                readOnly={page.pending}
                onChange={(event) => page.changeDraft(event.target.value)}
                className="min-h-96 flex-1 resize-none whitespace-pre-wrap leading-relaxed"
                autoFocus
              />
            ) : (
              <div
                role="document"
                aria-label={t`Memory text`}
                className="min-w-0 flex-1 select-text break-words text-sm leading-relaxed text-foreground/80"
              >
                {page.isLoading ? (
                  <span className="text-muted-foreground">
                    <Trans>Loading memory…</Trans>
                  </span>
                ) : page.content ? (
                  <MemoryDocument content={page.content} />
                ) : (
                  <span className="text-muted-foreground">
                    <Trans>No memory yet. Click Edit or ask your agent to remember something.</Trans>
                  </span>
                )}
              </div>
            )}
            {full && (
              <p role="status" className="text-sm text-destructive">
                <Trans>Memory is too long. Shorten it before saving.</Trans>
              </p>
            )}
            {page.error && (
              <p role="alert" className="text-sm text-destructive">
                {page.error}
              </p>
            )}
            <div className="flex shrink-0 items-center justify-between gap-3 pb-2">
              <p id="memory-size" className={full ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                <Plural value={page.usage.characters} one="# character" other="# characters" />
              </p>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground/80"
                title={page.isCopied ? t`Copied` : t`Copy`}
                aria-label={page.isCopied ? t`Copied` : t`Copy`}
                onClick={page.copy}
                disabled={!page.text || page.isLoading}
              >
                {page.isCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </fieldset>
          {page.edit && (
            <FormFooter>
              <Button variant="ghost" size="sm" onClick={page.cancel} disabled={disabled || page.pending}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                size="sm"
                onClick={page.save}
                disabled={disabled || page.pending || full || page.edit.draft === page.edit.before}
              >
                <Trans>Save</Trans>
              </Button>
            </FormFooter>
          )}
        </DetailPanel>
      </DetailPanelSurface>
      <Dialog
        open={page.preview !== null}
        onOpenChange={(open) => {
          if (!open && !page.pending) {
            page.patch({ preview: null, error: null })
          }
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              <Trans>Review compacted memory</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Check that every fact is preserved. Nothing changes until you apply.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <h3 className="font-medium">
                <Trans>Current memory</Trans>
              </h3>
              <div className="break-words text-muted-foreground">
                <MemoryDocument content={page.preview?.before ?? ''} />
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="font-medium">
                <Trans>Compacted memory</Trans>
              </h3>
              <div className="break-words">
                <MemoryDocument content={page.preview?.after ?? ''} />
              </div>
            </div>
          </div>
          {page.error && (
            <p role="alert" className="text-sm text-destructive">
              {page.error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={page.pending} onClick={() => page.patch({ preview: null, error: null })}>
              <Trans>Cancel</Trans>
            </Button>
            <Button disabled={disabled || page.pending} onClick={page.apply}>
              <Trans>Apply</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
