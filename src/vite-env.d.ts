/// <reference types="vite/client" />

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMetaEnv {
  readonly VITE_THUNDERBOLT_CLOUD_URL?: string
  readonly VITE_THUNDERBOLT_BACKEND_PORT?: string
  readonly VITE_AUTH_MODE?: 'thunderbolt' | 'oidc'
  readonly VITE_E2EE_ENABLED?: string
  readonly VITE_WAITLIST_ENABLED?: string
  readonly VITE_BYPASS_WAITLIST?: string
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMeta {
  readonly env: ImportMetaEnv
}
