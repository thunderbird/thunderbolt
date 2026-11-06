/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { RefObject } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { maxProjectNameLength } from '@/dal/projects'
import { EmojiPicker } from './emoji-picker'
import type { useProjectCreateState } from './use-project-create-state'

/** Create with a name and icon; the full project editor owns the optional details. */
export const ProjectCreateForm = ({
  form,
  inputRef,
  onCancel,
}: {
  form: ReturnType<typeof useProjectCreateState>
  inputRef: RefObject<HTMLInputElement | null>
  onCancel: () => void
}) => {
  const { t } = useLingui()
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        form.submit()
      }}
    >
      <fieldset disabled={form.isPending} className="min-w-0">
        <EmojiPicker value={form.icon} label={form.name || t`this project`} onChange={form.setIcon}>
          <Input
            ref={inputRef}
            autoFocus
            aria-label={t`Name`}
            placeholder={t`Project name`}
            value={form.name}
            maxLength={maxProjectNameLength}
            onChange={(event) => form.setName(event.target.value)}
            className="min-w-0 flex-1"
          />
        </EmojiPicker>
      </fieldset>
      {form.error && (
        <p role="alert" className="text-sm text-destructive">
          {form.error}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onPointerDown={(event) => {
            if (event.pointerType === 'touch') {
              event.preventDefault()
              inputRef.current?.blur()
              onCancel()
            }
          }}
          onClick={onCancel}
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!form.canCreate} isLoading={form.isPending} loadingLabel={t`Creating…`}>
          <Trans>Create</Trans>
        </Button>
      </DialogFooter>
    </form>
  )
}
