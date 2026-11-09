/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer } from 'react'
import { defaultPlan, type Plan } from '@/lib/model'

type State = {
  plan: Plan
  selectedMonth: string | null
  /** What the chat just changed (`field:<key>`, `hire:<i>`, `round:<i>`), pulsed briefly. */
  flash: string | null
}

type Action = { type: 'plan'; plan: Plan; flash?: string } | { type: 'select'; month: string } | { type: 'clearFlash' }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'plan':
      return { ...state, plan: action.plan, flash: action.flash ?? null }
    case 'select':
      return { ...state, selectedMonth: state.selectedMonth === action.month ? null : action.month }
    case 'clearFlash':
      return { ...state, flash: null }
  }
}

const flashDuration = 1400

/** Plan, focused month and the transient "just changed" marker. */
export const usePlanState = () => {
  const [state, dispatch] = useReducer(reducer, { plan: defaultPlan, selectedMonth: null, flash: null })

  useEffect(() => {
    if (!state.flash) {
      return
    }
    const timer = setTimeout(() => dispatch({ type: 'clearFlash' }), flashDuration)
    return () => clearTimeout(timer)
  }, [state.flash])

  return { ...state, dispatch }
}
