/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SshFolderPicker } from './ssh-folder-picker'

/** Keep manual paths available alongside explicit remote browsing. */
export const SshFolderInput = ({
  id,
  environmentId,
  value,
  onChange,
  disabled,
}: {
  id: string
  environmentId: string
  value: string
  onChange: (path: string) => void
  disabled?: boolean
}) => {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          required
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t`Browse remote folders`}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <FolderOpen className="size-4" />
        </Button>
      </div>
      {open && (
        <SshFolderPicker
          key={environmentId}
          environmentId={environmentId}
          value={value}
          onSelect={(path) => {
            onChange(path)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
