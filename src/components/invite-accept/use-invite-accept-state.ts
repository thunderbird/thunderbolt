/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth, useHttpClient } from '@/contexts'
import { HttpError } from '@/lib/http'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

type Invitation = { email: string; expiresAt: string }

export type InviteAcceptState =
  | { status: 'loading' }
  | { status: 'invalid' }
  | { status: 'error' }
  | { status: 'signed-in'; email: string }
  | { status: 'valid'; email: string }

/**
 * What the invite-accept screen shows for an invitation link's token. The backend answers 404 for
 * any invitation that can no longer be used. A visitor already signed in sees who they are.
 *
 * Once sign-in starts on this screen, the form stays up with the address it started with until it
 * finishes: the sign-in itself refetches the session (pending while it was signed out) and consumes
 * the invitation (so a refetch on focus answers 404), and either would otherwise unmount the form.
 */
export const useInviteAcceptState = (token: string) => {
  const httpClient = useHttpClient()
  const { data: session, isPending: sessionPending } = useAuth().useSession()
  const [signInEmail, setSignInEmail] = useState<string | null>(null)
  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => httpClient.get(`invitations/${encodeURIComponent(token)}`).json<Invitation>(),
    retry: false,
  })

  const signedInUser = session?.user && !session.user.isAnonymous ? session.user : null

  const state = ((): InviteAcceptState => {
    if (signInEmail) {
      return { status: 'valid', email: signInEmail }
    }
    if (sessionPending) {
      return { status: 'loading' }
    }
    if (signedInUser) {
      return { status: 'signed-in', email: signedInUser.email }
    }
    if (invitation.isPending) {
      return { status: 'loading' }
    }
    if (invitation.error) {
      return invitation.error instanceof HttpError && invitation.error.response.status === 404
        ? { status: 'invalid' }
        : { status: 'error' }
    }
    return { status: 'valid', email: invitation.data.email }
  })()

  return {
    state,
    onSignInStarted: () => setSignInEmail(invitation.data?.email ?? null),
    retry: () => invitation.refetch(),
  }
}
