/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { ArrowRight, KeyRound, Server } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { discoverServer, type DiscoveryResult } from '@/lib/discovery'
import { validateServerUrl, type ValidateServerUrlFn } from '@/components/boot/mode-picker'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'

/**
 * First-boot entry screen (spec-standalone-onboarding §5). Replaces `ModePicker`.
 * Two actions:
 *   - Log in → email → discovery → activate the matching server → reload.
 *   - Set up my own providers (advanced) → activate standalone → reload.
 * No disabled "on-device agent" card — the BYO-provider standalone flow IS the
 * on-device agent.
 */

type Choice = 'login' | 'standalone'

type State = {
  choice: Choice
  email: string
  error: string | null
  stage: 'picker' | 'discovering' | 'connecting'
}

type Action =
  | { type: 'SELECT'; choice: Choice }
  | { type: 'SET_EMAIL'; email: string }
  | { type: 'SUBMIT_START' }
  | { type: 'CONNECTING' }
  | { type: 'ERROR'; message: string }

const initialState: State = { choice: 'login', email: '', error: null, stage: 'picker' }

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'SELECT':
      return { ...state, choice: action.choice, error: null }
    case 'SET_EMAIL':
      return { ...state, email: action.email, error: null }
    case 'SUBMIT_START':
      return { ...state, stage: 'discovering', error: null }
    case 'CONNECTING':
      return { ...state, stage: 'connecting' }
    case 'ERROR':
      return { ...state, stage: 'picker', error: action.message }
  }
}

const isValidEmail = (email: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())

export type EntryScreenProps = {
  /** Overridable for tests. */
  discover?: (email: string) => Promise<DiscoveryResult>
  validate?: ValidateServerUrlFn
  reload?: () => void
}

export const EntryScreen = ({
  discover = discoverServer,
  validate = validateServerUrl,
  reload = () => window.location.reload(),
}: EntryScreenProps = {}) => {
  const [state, dispatch] = useReducer(reducer, initialState)

  const enterStandalone = () => {
    useTrustDomainRegistry.getState().activateStandalone()
    reload()
  }

  const handleContinue = async () => {
    if (state.choice === 'standalone') {
      enterStandalone()
      return
    }

    if (!isValidEmail(state.email)) {
      dispatch({ type: 'ERROR', message: 'Enter a valid email address.' })
      return
    }

    dispatch({ type: 'SUBMIT_START' })
    const discovery = await discover(state.email)
    if (!discovery.ok) {
      dispatch({ type: 'ERROR', message: discovery.message })
      return
    }

    dispatch({ type: 'CONNECTING' })
    const validated = await validate(discovery.serverUrl)
    if (!validated.ok) {
      dispatch({ type: 'ERROR', message: validated.message })
      return
    }
    useTrustDomainRegistry.getState().activateServer({ serverId: validated.serverId, cloudUrl: validated.cloudUrl })
    reload()
  }

  if (state.stage !== 'picker') {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-background">
        <AppLogo size={66} />
        <span className="text-2xl font-medium text-foreground">
          {state.stage === 'discovering' ? 'Finding your server…' : 'Connecting…'}
        </span>
      </div>
    )
  }

  const isLogin = state.choice === 'login'

  return (
    <div className="flex h-dvh w-full flex-col items-center bg-background px-6 pt-[92px]">
      <div className="flex items-center gap-2">
        <AppLogo size={60} />
        <span className="font-brand text-2xl font-medium leading-7 tracking-[-0.4px] text-foreground">Thunderbolt</span>
      </div>

      <div className="mt-[120px] flex w-full max-w-[520px] flex-col">
        <h1 className="text-center text-2xl font-medium text-foreground">Welcome to Thunderbolt</h1>

        <div className="mt-10 grid grid-cols-2 gap-6">
          <button
            type="button"
            onClick={() => dispatch({ type: 'SELECT', choice: 'login' })}
            className={cn(
              'flex flex-col gap-3 rounded-xl border p-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring',
              isLogin ? 'border-tertiary' : 'border-border',
            )}
          >
            <Server className={cn('size-10', isLogin ? 'text-lime-400' : 'text-muted-foreground/40')} />
            <div className="flex flex-col gap-1">
              <span className="text-[length:var(--font-size-lg)] font-medium text-foreground">
                Log in to your account
              </span>
              <span className="text-[length:var(--font-size-base)] text-muted-foreground">
                Enterprise or private-beta accounts
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => dispatch({ type: 'SELECT', choice: 'standalone' })}
            className={cn(
              'flex flex-col gap-3 rounded-xl border p-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring',
              !isLogin ? 'border-tertiary' : 'border-border',
            )}
          >
            <KeyRound className={cn('size-10', !isLogin ? 'text-lime-400' : 'text-muted-foreground/40')} />
            <div className="flex flex-col gap-1">
              <span className="text-[length:var(--font-size-lg)] font-medium text-foreground">
                Set up my own providers
              </span>
              <span className="text-[length:var(--font-size-base)] text-muted-foreground">
                Bring your own model &amp; search keys (advanced)
              </span>
            </div>
          </button>
        </div>

        {isLogin && (
          <div className="mt-6 flex flex-col gap-1.5">
            <label className="text-[length:var(--font-size-sm)] text-muted-foreground">Your email address:</label>
            <Input
              type="email"
              placeholder="you@company.com"
              value={state.email}
              onChange={(e) => dispatch({ type: 'SET_EMAIL', email: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleContinue()
                }
              }}
              state={state.error ? 'error' : 'default'}
              inputSize="lg"
            />
          </div>
        )}

        {state.error && (
          <p className="mt-2 text-[length:var(--font-size-sm)] text-destructive-foreground">{state.error}</p>
        )}
      </div>

      <div className="mt-8 flex w-full max-w-[520px] items-center justify-end">
        <Button size="lg" onClick={handleContinue}>
          {isLogin ? <ArrowRight className="size-4" /> : 'Continue'}
        </Button>
      </div>
    </div>
  )
}
