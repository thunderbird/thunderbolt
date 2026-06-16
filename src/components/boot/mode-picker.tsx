/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer, useRef } from 'react'
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
      // Reset `isValidating` too: if a blur kicked off `validate()` and the
      // user then edits the field, the in-flight result is stale and gets
      // dropped without dispatching success/error — without this reset the
      // flag would stick at true and the Continue button would never enable.
      return { ...state, serverUrl: action.url, serverUrlError: null, isUrlValidated: false, isValidating: false }
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

export type ValidationResult = { ok: true; serverId: string; cloudUrl: string } | { ok: false; message: string }

export type ValidateServerUrlFn = (userUrl: string) => Promise<ValidationResult>

export const validateServerUrl: ValidateServerUrlFn = async (userUrl) => {
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

type ModePickerProps = {
  /**
   * Server URL validator. Optional override for tests — defaults to the real
   * `validateServerUrl` which hits `GET <url>/v1/config`. Tests pass a mock
   * here instead of `mock.module('@/lib/http', ...)` so the global module
   * stays intact for other test files.
   */
  validate?: ValidateServerUrlFn
}

export const ModePicker = ({ validate = validateServerUrl }: ModePickerProps = {}) => {
  const [state, dispatch] = useReducer(reducer, initialState)

  // Mirror of the live `serverUrl` so async validate callbacks can detect that
  // the user typed something else while the request was in flight, and bail
  // out of applying a result that no longer matches. Updated on every render
  // AND synchronously in the input's `onChange` — the render-time write alone
  // races with a validate Promise that resolves before React commits the
  // SET_URL re-render, since the closure's `urlAtCall` and the (stale) ref
  // both still equal the previous value at that moment.
  const serverUrlRef = useRef(state.serverUrl)
  serverUrlRef.current = state.serverUrl

  // Cache of the last validate() resolution by URL. Reused when Continue
  // submits the same URL the user just blurred, so we don't pay the
  // /v1/config round-trip twice (and don't visually "re-validate" a URL the
  // user already saw a checkmark on).
  const lastValidationRef = useRef<{ url: string; result: ValidationResult } | null>(null)

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
    const urlAtCall = state.serverUrl
    // Skip if we already have a cached result for this exact URL — the second
    // blur after Continue's pre-validation would otherwise re-fire the network.
    if (lastValidationRef.current?.url === urlAtCall) {
      const cached = lastValidationRef.current.result
      dispatch(cached.ok ? { type: 'VALIDATE_SUCCESS' } : { type: 'VALIDATE_ERROR', message: cached.message })
      return
    }
    dispatch({ type: 'VALIDATE_START' })
    const result = await validate(urlAtCall)
    // Drop the result if the input has changed since we started — applying it
    // would either show a checkmark for the new text (when the old URL passed)
    // or show an error for text the user already replaced.
    if (urlAtCall !== serverUrlRef.current) {
      return
    }
    lastValidationRef.current = { url: urlAtCall, result }
    dispatch(result.ok ? { type: 'VALIDATE_SUCCESS' } : { type: 'VALIDATE_ERROR', message: result.message })
  }

  const handleContinue = async () => {
    if (state.selection === 'standalone') {
      useTrustDomainRegistry.getState().activateStandalone()
      window.location.reload()
      return
    }

    if (state.selection === 'server') {
      // Reuse the blur-time result when the URL hasn't changed since — avoids
      // a second round-trip and the click-while-blur-pending double-tap UX.
      const cached = lastValidationRef.current
      if (cached && cached.url === state.serverUrl && cached.result.ok) {
        dispatch({ type: 'CONNECT' })
        useTrustDomainRegistry
          .getState()
          .activateServer({ serverId: cached.result.serverId, cloudUrl: cached.result.cloudUrl })
        window.location.reload()
        return
      }

      dispatch({ type: 'CONNECT' })
      const urlAtCall = state.serverUrl
      const result = await validate(urlAtCall)
      if (urlAtCall !== serverUrlRef.current) {
        // User edited the field during the network call — bail rather than
        // surface a result for stale text. Reset the stage so we don't strand
        // the user on the "Connecting to Server" screen with no recovery path.
        dispatch({ type: 'VALIDATE_ERROR', message: '' })
        return
      }
      lastValidationRef.current = { url: urlAtCall, result }
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
                onChange={(e) => {
                  // Close the in-flight-validate race window — keep the ref
                  // in lockstep with user input so a Promise resolving before
                  // the SET_URL render commit can still detect the mismatch.
                  serverUrlRef.current = e.target.value
                  dispatch({ type: 'SET_URL', url: e.target.value })
                }}
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
