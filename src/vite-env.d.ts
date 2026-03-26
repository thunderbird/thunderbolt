/// <reference types="vite/client" />

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMetaEnv {
  readonly VITE_THUNDERBOLT_CLOUD_URL?: string
  readonly VITE_AUTH_MODE?: 'thunderbolt' | 'oidc'
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface ImportMeta {
  readonly env: ImportMetaEnv
}
