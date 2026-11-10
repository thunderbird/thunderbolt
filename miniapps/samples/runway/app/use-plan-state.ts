/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useReducer } from 'react'
import { defaultPlan, type Plan } from '@/lib/model'
import { parsePlan, planStorageKey, serializePlan } from '@/lib/plan-storage'

type State = {
  plan: Plan
  selectedMonth: string | null
  /** What the chat just changed (`field:<key>`, `hire:<i>`, `round:<i>`), pulsed briefly. */
  flash: string | null
  /** False until the stored plan has been read on the client, so the first save can't clobber it. */
  restored: boolean
}

type Action =
  | { type: 'plan'; plan: Plan; flash?: string }
  | { type: 'select'; month: string }
  | { type: 'restore'; plan: Plan }
  | { type: 'clearFlash' }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'plan':
      return { ...state, plan: action.plan, flash: action.flash ?? null }
    case 'restore':
      return { ...state, plan: action.plan, restored: true }
    case 'select':
      return { ...state, selectedMonth: state.selectedMonth === action.month ? null : action.month }
    case 'clearFlash':
      return { ...state, flash: null }
  }
}

const flashDuration = 1400

/**
 * Plan, focused month and the transient "just changed" marker. Only the plan
 * persists (localStorage). The server and first client render use the default
 * plan so hydration matches; the stored plan is restored right after mount.
 */
export const usePlanState = () => {
  const [state, dispatch] = useReducer(reducer, {
    plan: defaultPlan,
    selectedMonth: null,
    flash: null,
    restored: false,
  })

  useEffect(() => {
    dispatch({ type: 'restore', plan: parsePlan(localStorage.getItem(planStorageKey)) })
  }, [])

  useEffect(() => {
    if (!state.restored) {
      return
    }
    const stored = serializePlan(state.plan)
    if (stored === null) {
      localStorage.removeItem(planStorageKey)
      return
    }
    localStorage.setItem(planStorageKey, stored)
  }, [state.plan, state.restored])

  useEffect(() => {
    if (!state.flash) {
      return
    }
    const timer = setTimeout(() => dispatch({ type: 'clearFlash' }), flashDuration)
    return () => clearTimeout(timer)
  }, [state.flash])

  return { ...state, dispatch }
}
