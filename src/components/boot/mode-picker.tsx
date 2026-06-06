/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { ArrowRight, Bot, Check, Server } from 'lucide-react'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { AppConfig } from '@/api/config-store'
import { createClient, HttpError } from '@/lib/http'
import { useTrustDomainRegistry } from '@/stores/trust-domain-registry'

type Mode = 'standalone' | 'server'

type State = {
  selection: Mode | null
  serverUrl: string
  serverUrlError: string | null
  isValidating: boolean
  isUrlValidated: boolean
  stage: 'picker' | 'connecting'
}

type Action =
  | { type: 'SELECT'; mode: Mode }
  | { type: 'SET_URL'; url: string }
  | { type: 'VALIDATE_START' }
  | { type: 'VALIDATE_SUCCESS' }
  | { type: 'VALIDATE_ERROR'; message: string }
  | { type: 'CONNECT' }

const initialState: State = {
  selection: 'server',
  serverUrl: '',
  serverUrlError: null,
  isValidating: false,
  isUrlValidated: false,
  stage: 'picker',
}

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'SELECT':
      return { ...state, selection: action.mode, serverUrlError: null, isUrlValidated: false }
    case 'SET_URL':
      return { ...state, serverUrl: action.url, serverUrlError: null, isUrlValidated: false }
    case 'VALIDATE_START':
      return { ...state, isValidating: true, serverUrlError: null }
    case 'VALIDATE_SUCCESS':
      return { ...state, isValidating: false, isUrlValidated: true }
    case 'VALIDATE_ERROR':
      return { ...state, isValidating: false, isUrlValidated: false, serverUrlError: action.message, stage: 'picker' }
    case 'CONNECT':
      return { ...state, stage: 'connecting' }
  }
}

// Normalize whatever the user typed into a bare base URL (no trailing slash, no /v1).
// Accepted forms: "app.thunderbolt.io", "app.thunderbolt.io/", "http://...", "https://.../v1"
const normalizeBaseUrl = (url: string): string => {
  let s = url.trim().replace(/\/+$/, '')
  if (s.endsWith('/v1')) {
    s = s.slice(0, -3)
  }
  if (!s.startsWith('http://') && !s.startsWith('https://')) {
    const isLocal = s.startsWith('localhost') || s.startsWith('127.0.0.1')
    s = `${isLocal ? 'http' : 'https'}://${s}`
  }
  return s
}

type ValidationResult = { ok: true; serverId: string; cloudUrl: string } | { ok: false; message: string }

const validateServerUrl = async (userUrl: string): Promise<ValidationResult> => {
  const base = normalizeBaseUrl(userUrl)
  const client = createClient({ prefixUrl: `${base}/v1` })
  try {
    const config = await client.get('config', { timeout: 5_000 }).json<AppConfig>()
    if (!config?.serverId) {
      return { ok: false, message: "This URL doesn't look like a Thunderbolt server" }
    }
    return { ok: true, serverId: config.serverId, cloudUrl: `${base}/v1` }
  } catch (err) {
    return err instanceof HttpError
      ? { ok: false, message: "This URL doesn't look like a Thunderbolt server" }
      : { ok: false, message: "Couldn't reach this server" }
  }
}

export const ModePicker = () => {
  const [state, dispatch] = useReducer(reducer, initialState)

  const isServerMode = state.selection === 'server'
  // Dots: left = initial pick, right = server URL step
  const activeDot = isServerMode ? 1 : 0

  const canContinue =
    state.selection !== null && !state.isValidating && (state.selection !== 'server' || state.serverUrl.trim() !== '')

  const handleSkip = () => {
    useTrustDomainRegistry.getState().activateStandalone()
    window.location.reload()
  }

  const handleBlur = async () => {
    if (!isServerMode || !state.serverUrl.trim()) {
      return
    }
    dispatch({ type: 'VALIDATE_START' })
    const result = await validateServerUrl(state.serverUrl)
    dispatch(result.ok ? { type: 'VALIDATE_SUCCESS' } : { type: 'VALIDATE_ERROR', message: result.message })
  }

  const handleContinue = async () => {
    if (state.selection === 'standalone') {
      useTrustDomainRegistry.getState().activateStandalone()
      window.location.reload()
      return
    }

    if (state.selection === 'server') {
      dispatch({ type: 'CONNECT' })
      const result = await validateServerUrl(state.serverUrl)
      if (!result.ok) {
        dispatch({ type: 'VALIDATE_ERROR', message: result.message })
        return
      }
      useTrustDomainRegistry.getState().activateServer({ serverId: result.serverId, cloudUrl: result.cloudUrl })
      window.location.reload()
    }
  }

  if (state.stage === 'connecting') {
    return (
      <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-background">
        <AppLogo size={66} />
        <span className="text-2xl font-medium text-foreground">Connecting to Server</span>
      </div>
    )
  }

  return (
    <div className="flex h-dvh w-full flex-col items-center bg-background px-6 pt-[92px]">
      {/* Branding */}
      <div className="flex items-center gap-2">
        <AppLogo size={60} />
        <span className="font-brand text-2xl font-medium leading-7 tracking-[-0.4px] text-foreground">Thunderbolt</span>
      </div>

      <div className="mt-[150px] flex w-full max-w-[520px] flex-col">
        <h1 className="text-center text-2xl font-medium text-foreground">How would you like to use Thunderbolt?</h1>

        {/* Option cards */}
        <div className="mt-10 grid grid-cols-2 gap-6">
          <button
            type="button"
            disabled
            className="flex cursor-not-allowed flex-col gap-3 rounded-xl border border-border p-4 text-left opacity-40 outline-none"
          >
            <Bot className="size-10 text-muted-foreground/40" />
            <div className="flex flex-col gap-1">
              <span className="text-[length:var(--font-size-lg)] font-medium text-foreground">
                Set up an on-device agent
              </span>
              <span className="text-[length:var(--font-size-base)] text-muted-foreground">
                Deploy a private AI agent directly on your device
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => dispatch({ type: 'SELECT', mode: 'server' })}
            className={cn(
              'flex flex-col gap-3 rounded-xl border p-4 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring',
              state.selection === 'server' ? 'border-tertiary' : 'border-border',
            )}
          >
            <Server
              className={cn('size-10', state.selection === 'server' ? 'text-lime-400' : 'text-muted-foreground/40')}
            />
            <div className="flex flex-col gap-1">
              <span className="text-[length:var(--font-size-lg)] font-medium text-foreground">
                Connect to AI server
              </span>
              <span className="text-[length:var(--font-size-base)] text-muted-foreground">
                Connect instantly to any Thunderbolt AI server
              </span>
            </div>
          </button>
        </div>

        {/* Server URL input */}
        {isServerMode && (
          <div className="mt-6 flex flex-col gap-1.5">
            <label className="text-[length:var(--font-size-sm)] text-muted-foreground">Enter Server's URL:</label>
            <div className="relative">
              <Input
                type="url"
                placeholder="app.thunderbolt.io/"
                value={state.serverUrl}
                onChange={(e) => dispatch({ type: 'SET_URL', url: e.target.value })}
                onBlur={handleBlur}
                state={state.serverUrlError ? 'error' : 'default'}
                disabled={state.isValidating}
                className={cn(state.isUrlValidated && 'pr-9')}
                inputSize="lg"
              />
              {state.isUrlValidated && (
                <Check className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-green-500" />
              )}
            </div>
            {state.serverUrlError && (
              <p className="text-[length:var(--font-size-sm)] text-destructive-foreground">{state.serverUrlError}</p>
            )}
          </div>
        )}
      </div>

      {/* Footer: Skip — dots — Continue */}
      <div className="relative mt-8 flex w-full max-w-[520px] items-center">
        <Button variant="outline" size="lg" onClick={handleSkip}>
          Skip
        </Button>

        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5">
          {[0, 1].map((i) => (
            <div
              key={i}
              className={cn(
                'size-1.5 rounded-full transition-colors',
                activeDot === i ? 'bg-foreground' : 'bg-muted-foreground/30',
              )}
            />
          ))}
        </div>

        <Button size="lg" onClick={handleContinue} disabled={!canContinue} className="ml-auto">
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
