/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useTransition } from 'react'
import { useLingui } from '@lingui/react/macro'

export type ProjectCreateValues = { name: string; icon: string | null }
type State = ProjectCreateValues & { error: string | null }

/** Keep the compact form editable after a failed creation and prevent blank submissions. */
export const useProjectCreateState = (onSubmit: (values: ProjectCreateValues) => Promise<void>) => {
  const { t } = useLingui()
  const [state, update] = useReducer((current: State, changes: Partial<State>) => ({ ...current, ...changes }), {
    name: '',
    icon: null,
    error: null,
  })
  const [isPending, startTransition] = useTransition()
  const canCreate = state.name.trim().length > 0 && !isPending

  return {
    ...state,
    isPending,
    canCreate,
    setName: (name: string) => update({ name, error: null }),
    setIcon: (icon: string | null) => update({ icon, error: null }),
    submit: () => {
      if (!canCreate) {
        return
      }
      startTransition(async () => {
        try {
          await onSubmit({ name: state.name.trim(), icon: state.icon })
        } catch (error) {
          console.error('[projects] Could not create project', error)
          update({ error: t`Could not create the project.` })
        }
      })
    },
  }
}
