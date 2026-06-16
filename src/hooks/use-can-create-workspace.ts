/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore, type AppConfig } from '@/api/config-store'
import { useAuth } from '@/contexts'

type GateInput = {
  hasSession: boolean
  isAnonymous: boolean
  config: AppConfig
}

/**
 * Pure gating logic for the "Create Workspace" affordance — exported separately
 * from the hook so it can be unit-tested without the AuthProvider/DB plumbing
 * that `useAuth` requires. The BE upload handler is the authoritative enforcer;
 * this controls UI visibility only.
 *
 * Returns `false` when:
 * - no session is loaded yet (the affordance shouldn't render before auth)
 * - the active user is anonymous and `allowWorkspaceCreationByAnon === false`
 * - the active user is real and `allowWorkspaceCreationByMembers === false`
 *
 * Treats absent flags as "allowed" — matches `selectAllowCustomAgents` /
 * `selectBuiltInAgentEnabled`, so offline boots without server config fall
 * back to the permissive path.
 */
export const canCreateWorkspace = ({ hasSession, isAnonymous, config }: GateInput): boolean => {
  if (!hasSession) {
    return false
  }
  if (isAnonymous) {
    return config.allowWorkspaceCreationByAnon !== false
  }
  return config.allowWorkspaceCreationByMembers !== false
}

/** Hook variant — reads session + config from context and forwards to `canCreateWorkspace`. */
export const useCanCreateWorkspace = (): boolean => {
  const authClient = useAuth()
  const { data: session } = authClient.useSession()
  const config = useConfigStore((state) => state.config)
  return canCreateWorkspace({
    hasSession: !!session?.user,
    isAnonymous: session?.user?.isAnonymous === true,
    config,
  })
}
