/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { SshConnection } from './agent-core/ssh-transport'

/** Local apps belong to one project, or to a standalone chat. */
export type LocalAppOwner = { kind: 'project' | 'chat'; id: string }

/** Arguments are passed without a shell; {port} expands to the allocated preview port. */
export type LocalAppLaunch =
  | { mode?: 'launch'; executable: string; args: string[]; port?: number }
  | { mode: 'attach'; port: number }

/** This recipe and its filesystem path remain on this device. */
export type LocalApp = {
  id: string
  owner: LocalAppOwner
  title: string
  cwd: string
  launch: LocalAppLaunch
  /** Exact SSH destination for remote previews; omitted for recipes running on this computer. */
  connection?: SshConnection
  createdAt: string
  deletedAt?: string
}

export type LocalAppStatus = {
  id: string
  status: 'starting' | 'ready' | 'stopped' | 'failed'
  url: string | null
  error: string | null
  logs: string
}
