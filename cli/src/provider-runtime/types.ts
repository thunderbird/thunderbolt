/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AgentHarness, AgentHarnessEvent, ToolCallEvent, ToolCallResult } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model, MutableModels } from '@earendil-works/pi-ai'
import type { RequestInfo } from 'undici-types'
import type { SharedModel } from '../../../shared/defaults/models.ts'
import type { BuiltinProvider } from '../agent/types.ts'
import type { LogoutResult } from '../auth/logout.ts'

export type AccountFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export type ManagedCatalog = {
  readonly version: number
  readonly defaultModelId: string
  readonly data: SharedModel[]
}
export type ManagedCatalogLoader = (
  backendUrl: string,
  fetchFn?: AccountFetch,
  timeoutMs?: number,
) => Promise<ManagedCatalog>
export type ProviderStatus = 'authenticated' | 'not authenticated' | 'authentication required'
export type DeviceGrantPresentation = {
  readonly showVerification: (value: {
    readonly verificationUrl: string
    readonly userCode: string
    readonly qrBlock?: string
  }) => void
  readonly showStatus: (status: 'waiting' | 'success' | 'error', message?: string) => void
  readonly promptToOpenBrowser?: (url: string) => Promise<void>
}
export type ProviderManagerItem = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly wireModel?: string
  readonly confidential?: boolean
}
export type ProviderManagerIO = DeviceGrantPresentation & {
  readonly choose: (title: string, items: readonly ProviderManagerItem[]) => Promise<string | null>
  readonly readText: (prompt: string) => Promise<string | null>
  readonly readSecret: (prompt: string) => Promise<string | null>
  readonly write: (text: string) => void
}

export type FireworksModelApi = 'anthropic-messages' | 'openai-completions'

export type ByokProfile = {
  readonly id: string
  readonly label: string
  readonly defaultModel: string
  readonly apiKey: string | null
  readonly credentialStatus: 'authenticated' | 'not-authenticated' | 'authentication-required'
} & (
  | { readonly provider: Exclude<BuiltinProvider, 'fireworks'> }
  | { readonly provider: 'fireworks'; readonly modelApi?: FireworksModelApi }
  | { readonly provider: 'openai-compat'; readonly baseUrl: string }
)

export type CliConfig = {
  readonly version: 3
  readonly activeProviderId: 'thunderbolt' | string | null
  readonly thunderbolt: { readonly defaultModelId: string }
  readonly providers: readonly ByokProfile[]
}

export type CliAuth = {
  readonly version: 2
  readonly backendUrl: string
  readonly deviceId: `cli-${string}`
  readonly userCacheSecret: string
} & (
  | { readonly registration: 'legacy' | 'registered'; readonly bearer: string }
  | { readonly registration: 'authentication-required'; readonly bearer: null }
)

export type ResolvedAccountCredential =
  | {
      readonly type: 'session'
      readonly backendUrl: string
      readonly bearer: string
      readonly deviceId: `cli-${string}`
      readonly userCacheSecret: Uint8Array
    }
  | { readonly type: 'pat'; readonly backendUrl: string; readonly token: string }

export type SessionCredential = Extract<ResolvedAccountCredential, { readonly type: 'session' }>

export type InvocationSelection = {
  readonly providerId?: 'thunderbolt' | string
  readonly model?: string
  readonly apiKey?: string
  readonly baseUrl?: string
}
export type ProviderSwitchCommand =
  | { readonly type: 'use'; readonly providerId: 'thunderbolt' | string; readonly model?: string }
  | {
      readonly type: 'commit-staged-byok'
      readonly providerId: string
      readonly activate: boolean
    }
  | { readonly type: 'select-model'; readonly providerId: 'thunderbolt' | string; readonly model: string }

export type ProviderCommand =
  | ProviderSwitchCommand
  | { readonly type: 'commit-persistence'; readonly command: ProviderSwitchCommand }
  | { readonly type: 'remove-byok'; readonly providerId: string }
  | { readonly type: 'load-models'; readonly providerId: 'thunderbolt' | string }
  | { readonly type: 'login'; readonly presentation: DeviceGrantPresentation; readonly signal?: AbortSignal }
  | { readonly type: 'logout'; readonly presentation: DeviceGrantPresentation; readonly signal?: AbortSignal }
  | { readonly type: 'clear-active' }
  | { readonly type: 'rollback-persistence'; readonly revision: number }
  | { readonly type: 'finalize-persistence'; readonly revision: number }

export type ProviderSnapshot = {
  readonly revision: number
  readonly activeProviderId: 'thunderbolt' | string | null
  readonly thunderbolt: {
    readonly status: ProviderStatus
    readonly defaultModelId: string
    readonly models?: readonly ProviderManagerItem[]
  }
  readonly providers: readonly {
    readonly id: string
    readonly label: string
    readonly provider: string
    readonly status: ProviderStatus
    readonly defaultModel: string
    readonly models?: readonly ProviderManagerItem[]
    readonly modelApi?: FireworksModelApi
  }[]
}

export type ProviderRuntimeError = {
  readonly code:
    | 'config-invalid'
    | 'provider-not-found'
    | 'model-not-found'
    | 'authentication-required'
    | 'authentication-rejected'
    | 'device-disconnected'
    | 'WEB_LOGIN_REQUIRED'
    | 'network'
    | 'attestation-failed'
    | 'persistence-failed'
  readonly message: string
}

/** Creates an Error carrying a stable provider-runtime error code. */
export const providerRuntimeError = <Code extends ProviderRuntimeError['code']>(
  code: Code,
  message: string,
): Error & ProviderRuntimeError & { readonly code: Code } => Object.assign(new Error(message), { code, message })

/** Narrows an Error to the provider-runtime contract and optional exact code. */
export const isProviderRuntimeError = <Code extends ProviderRuntimeError['code']>(
  error: Error,
  code?: Code,
): error is Error & ProviderRuntimeError & { readonly code: Code } =>
  'code' in error && (code === undefined || error.code === code)

export type PreparedPiBinding = {
  readonly providerId: 'thunderbolt' | string
  readonly wireModel: string
  readonly persistsCredentialStatus: boolean
  readonly piModel: Model<Api>
  readonly install: (models: MutableModels) => void
  readonly attach: (harness: AgentHarness) => () => void
  readonly observePromptError: (failure: Error | AssistantMessage) => Promise<void>
  readonly dispose: () => Promise<void>
}

export const noopBindingLifecycle = {
  attach: () => () => {},
  observePromptError: async () => {},
  dispose: async () => {},
} satisfies Pick<PreparedPiBinding, 'attach' | 'observePromptError' | 'dispose'>

export type HarnessRuntime = {
  readonly subscribe: (listener: (event: AgentHarnessEvent) => void) => () => void
  readonly registerToolCallGate: (handler: (event: ToolCallEvent) => Promise<ToolCallResult | undefined>) => void
  readonly steer: (text: string) => Promise<void>
  readonly prompt: (text: string) => Promise<AssistantMessage>
  readonly abort: () => Promise<void>
  readonly currentProviderId: () => string | null
  readonly switchBinding: (
    binding: PreparedPiBinding,
    transaction: HarnessBindingTransaction,
    options: { readonly forceReplace: boolean },
  ) => Promise<void>
  readonly deactivate: (
    persist: () => Promise<void>,
    options: { readonly onPersistFailure: 'restore-binding' | 'remain-deactivated' },
  ) => Promise<void>
  readonly dispose: () => Promise<void>
}

export type HarnessBindingTransaction = {
  readonly commit: () => Promise<void>
  readonly rollback: () => Promise<void>
  readonly finalize: () => Promise<void>
}

export type ProviderRuntime = {
  readonly snapshot: () => ProviderSnapshot
  readonly manage: (command: ProviderCommand) => Promise<ProviderSnapshot>
  readonly prepare: (selection: InvocationSelection, signal?: AbortSignal) => Promise<PreparedPiBinding>
}

export type CommandOutcome =
  | {
      readonly kind: 'switch'
      readonly selection: InvocationSelection
      readonly persist: ProviderSwitchCommand
      readonly forceReplace: boolean
    }
  | {
      readonly kind: 'deactivate'
      readonly persist: ProviderCommand | null
      readonly failure?: Error & ProviderRuntimeError
    }
  | { readonly kind: 'handled' }
  | { readonly kind: 'forward'; readonly text: string }
  | { readonly kind: 'exit' }
export type ProviderManagerMode = 'providers' | 'models' | 'first-run' | 'login' | 'logout'
export type ProviderManagerRunner = (mode: ProviderManagerMode) => Promise<CommandOutcome>
export type AccountActions = {
  readonly login: (
    presentation: DeviceGrantPresentation,
    signal?: AbortSignal,
  ) => Promise<Extract<CliAuth, { readonly bearer: string }>>
  readonly logout: (presentation: DeviceGrantPresentation, signal?: AbortSignal) => Promise<LogoutResult>
}
