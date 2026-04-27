/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { X } from 'lucide-react'
import { type ComponentProps } from 'react'
import { Button } from './button'

export const SidebarCloseButton = ({ onClick, ...props }: ComponentProps<typeof Button> & { onClick: () => void }) => (
  <Button
    onClick={onClick}
    variant="ghost"
    size="icon"
    className="size-[var(--touch-height-sm)] rounded-full"
    {...props}
  >
    <X className="size-[var(--icon-size-default)]" />
  </Button>
)
