# Thunderbolt Architecture

```mermaid
graph TB
  subgraph LOCAL["User Device"]
    direction TB
    TAURI["Tauri Shell<br/><sub>Desktop · iOS · Android</sub>"]
    UI["React Frontend<br/><sub>React 19 · Vite · Radix UI</sub>"]
    STATE["State & Data<br/><sub>Zustand · TanStack Query · Drizzle</sub>"]
    AI["AI Chat<br/><sub>Vercel AI SDK · MCP Client</sub>"]
    CRYPTO["E2E Encryption <i>(optional)</i><br/><sub>ECDH P-256 · ML-KEM-768 · AES-256-GCM</sub>"]
    SQLITE[("SQLite<br/><sub>Offline-first</sub>")]
    KEYSTORE[("IndexedDB<br/><sub>CryptoKeys</sub>")]

    TAURI --- UI
    UI --- STATE
    UI --- AI
    STATE --- CRYPTO
    CRYPTO --- SQLITE
    CRYPTO --- KEYSTORE
  end

  subgraph SERVER["Server Infrastructure <i>(self-hostable)</i>"]
    direction TB
    API["Backend API<br/><sub>Elysia on Bun</sub>"]
    AUTH["Auth<br/><sub>Better Auth · OTP · OIDC</sub>"]
    INFERENCE["Inference Proxy<br/><sub>Rate Limiting · Routing</sub>"]
    ENCRYPT_API["Encryption API<br/><sub>Envelopes · Device Reg</sub>"]
    PS["PowerSync<br/><sub>WAL Replication · Bucket Sync</sub>"]
    PG[("PostgreSQL")]

    API --- AUTH
    API --- INFERENCE
    API --- ENCRYPT_API
    PS --- PG
    AUTH --- PG
    ENCRYPT_API --- PG
  end

  subgraph EXTERNAL["External Services"]
    direction TB
    LLM["LLM Providers<br/><sub>Anthropic · OpenAI · Mistral · OpenRouter</sub>"]
    OAUTH["OAuth<br/><sub>Google · Microsoft</sub>"]
    POSTHOG["PostHog<br/><sub>Analytics</sub>"]
    RESEND["Resend<br/><sub>Email</sub>"]
  end

  STATE -- "encrypted sync<br/>(HTTPS)" --> PS
  STATE -- "REST / HTTPS" --> API
  AI -- "SSE streaming" --> INFERENCE
  CRYPTO -- "device keys &<br/>envelopes" --> ENCRYPT_API
  UI -- "OAuth redirect" --> AUTH

  INFERENCE --> LLM
  AUTH --> OAUTH
  API --> POSTHOG
  API --> RESEND

  style LOCAL fill:#0f172a,stroke:#3b82f6,stroke-width:2px,color:#e2e8f0
  style SERVER fill:#0f172a,stroke:#8b5cf6,stroke-width:2px,color:#e2e8f0
  style EXTERNAL fill:#0f172a,stroke:#ec4899,stroke-width:2px,color:#e2e8f0
```

> **Boundary key:** Blue = on-device · Purple = server · Pink = third-party SaaS

## Boundary Legend

| Boundary | Description |
|---|---|
| **User Device (Local)** | Everything runs on the user's machine. SQLite + CryptoKeys never leave the device. When E2E encryption is enabled, private encryption keys are non-extractable. |
| **Network Boundary** | All traffic is HTTPS. When E2E encryption is enabled, encrypted payloads pass through — the server cannot read user data. |
| **Server Infrastructure** | Self-hostable backend + sync engine + databases. When E2E encryption is enabled, stores only ciphertext and public keys. |
| **External Services** | Third-party SaaS — LLM providers, OAuth, analytics, email, app updates. |

## Key Architectural Properties

- **Offline-first**: Local SQLite is the source of truth. The app works without network.
- **E2E Encrypted (optional)**: When enabled, data is encrypted with AES-256-GCM before leaving the device. The server stores only ciphertext. Private keys (ECDH P-256 + ML-KEM-768) are non-extractable from IndexedDB.
- **Server-blind (with E2E)**: When encryption is enabled, the backend cannot decrypt user data — it lacks device private keys. The decryption chain is permanently broken at the envelope unwrap step.
- **Cross-platform**: A single React codebase runs in Tauri on desktop (macOS, Linux, Windows) and mobile (iOS, Android).
- **Model-agnostic**: LLM calls route through the backend inference proxy, supporting Claude, GPT, Mistral, and OpenRouter.
- **Self-hostable**: The entire server stack (backend, PostgreSQL, PowerSync, Keycloak) runs via Docker Compose.

## Data Sync Flow

> **Note:** Multi-device sync is under active development and is subject to further refinements.

```mermaid
sequenceDiagram
  participant Device as User Device
  participant SQLite as Local SQLite
  participant Crypto as Crypto Layer
  participant PS as PowerSync Service
  participant PG as PostgreSQL

  Note over Device,PG: Write Path (Local → Server)
  Device->>SQLite: Write plaintext
  SQLite->>Crypto: Intercept mutation
  Crypto->>Crypto: Encrypt with Content Key (AES-256-GCM)
  Crypto->>PS: Push encrypted row
  PS->>PG: Write ciphertext to WAL

  Note over Device,PG: Read Path (Server → Device)
  PG->>PS: Stream WAL changes
  PS->>PS: Match bucket rules (user_id)
  PS->>Crypto: Push encrypted row
  Crypto->>Crypto: Unwrap CK from device envelope
  Crypto->>Crypto: Decrypt with Content Key
  Crypto->>SQLite: Write plaintext
  SQLite->>Device: Query results
```

## Encryption Key Hierarchy

> **Note:** End-to-end encryption is under active development, has not yet undergone a cryptography audit, and is subject to further refinements.

```mermaid
graph TD
  classDef key fill:#1e293b,stroke:#f59e0b,color:#e2e8f0
  classDef derived fill:#1e293b,stroke:#34d399,color:#e2e8f0
  classDef data fill:#1e293b,stroke:#60a5fa,color:#e2e8f0

  RK["Recovery Key<br/>24-word BIP-39 mnemonic<br/>(user-managed secret)"]
  DK["Device Key Pair<br/>ECDH P-256 + ML-KEM-768<br/>(per device, non-extractable)"]
  CK["Content Key<br/>AES-256-GCM<br/>(same across all devices)"]
  ENV["Device Envelope<br/>CK wrapped with hybrid<br/>ECDH + ML-KEM per device"]
  DATA["Encrypted User Data<br/>Chat threads · Messages · Tasks<br/>Settings · Prompts · Models"]
  CANARY["Canary<br/>Encrypted fixed plaintext<br/>(verifies recovery key)"]

  RK -->|"Can regenerate CK"| CK
  RK -->|"Verifies against"| CANARY
  DK -->|"Unwraps"| ENV
  ENV -->|"Contains"| CK
  CK -->|"Encrypts / Decrypts"| DATA

  class RK,DK key
  class CK,ENV derived
  class DATA,CANARY data
```
