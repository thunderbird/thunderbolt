/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Server } from 'lucide-react'
import type { SshEnvironment } from '@/agent-execution/ssh-environments'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { SshEnvironmentStatus } from './ssh-environment-status'

/** One SSH choice shared by the project creator and standalone-chat selector. */
export const SshEnvironmentMenuItem = ({
  environment,
  onSelect,
}: {
  environment: SshEnvironment
  onSelect: () => void
}) => (
  <DropdownMenuItem className="cursor-pointer" onSelect={onSelect}>
    <Server />
    <span className="min-w-0 flex-1">
      <span className="block truncate">{environment.name}</span>
      <span className="block truncate text-xs text-muted-foreground">{environment.cwd}</span>
    </span>
    <SshEnvironmentStatus environmentId={environment.id} />
  </DropdownMenuItem>
)
