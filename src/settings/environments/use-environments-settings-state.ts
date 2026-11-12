/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'
import { invoke } from '@tauri-apps/api/core'
import { sshConnection, useSshEnvironmentsStore, type SshEnvironment } from '@/agent-execution/ssh-environments'
import { isTauriDesktop } from '@/lib/platform'

/** Owns SSH settings selection and removes credentials before soft-deleting their environment. */
export const useEnvironmentsSettingsState = () => {
  const { t } = useLingui()
  const environments = useSshEnvironmentsStore((state) => state.environments)
  const [{ panel, error }, setPanel] = useState<{ panel: string | null; error: string | null }>({
    panel: null,
    error: null,
  })
  const [pending, startTransition] = useTransition()
  const [removal, setRemoval] = useState<SshEnvironment | null>(null)
  const open = (panel: string) => setPanel({ panel, error: null })
  const close = () => setPanel({ panel: null, error: null })
  const confirmRemoval = () => {
    if (!removal) {
      return
    }
    const environment = removal
    setRemoval(null)
    startTransition(async () => {
      try {
        if (environment.hasSecret || environment.authentication === 'password') {
          await invoke('agent_ssh_set_secret', { connection: sshConnection(environment), secret: null })
        }
        useSshEnvironmentsStore.getState().deleteEnvironment(environment.id)
        setPanel((current) => (current.panel === environment.id ? { panel: null, error: null } : current))
      } catch {
        setPanel((current) =>
          current.panel === environment.id
            ? { ...current, error: t`Could not remove this SSH environment. Please try again.` }
            : current,
        )
      }
    })
  }
  return {
    panel,
    error,
    pending,
    removal,
    active: panel ? environments[panel] : undefined,
    visible: Object.values(environments).filter((environment) => !environment.deletedAt),
    desktop: isTauriDesktop(),
    open,
    close,
    requestRemoval: setRemoval,
    cancelRemoval: () => setRemoval(null),
    confirmRemoval,
  }
}
