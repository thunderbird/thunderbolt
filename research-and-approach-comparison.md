# Research and Approach Comparison

> This document explains how Thunderbolt's encryption model works, how it compares to other approaches — including our own previous design — and why we made the choices we did.
> 

---

## The core problem every E2E encrypted app must solve

End-to-end encryption means the server stores only ciphertext it cannot read. That guarantee requires one thing: **the encryption key must never reach the server in plaintext.**

The hard part is not the encryption itself — AES-256-GCM is well understood and widely available in every browser via the Web Crypto API. The hard part is **key management**: how does a user get their key onto a new device without the server ever seeing it? And what happens if they lose everything?

Every E2E encrypted app answers these questions differently. The answers reflect trade-offs between security, usability, and the level of trust placed in the server.

---

## Comparison at a glance

|  | Old Thunderbolt | **New Thunderbolt** | Signal / WhatsApp |
| --- | --- | --- | --- |
| **Zero-knowledge server** | Yes | Yes — fully | Yes |
| **User credential burden** | Email + 2FA + passphrase | Email + 2FA only | Phone number |
| **New device UX** | Enter passphrase | Approve from trusted device | Mandatory QR scan |
| **Recovery if all devices lost** | Recovery key | Recovery key | Permanent data loss |
| **Server assists key delivery** | No | Yes (transiently, first device only) | No |
| **Private key leaves device** | N/A | Never | Never |
| **Key tied to user secret** | Yes (passphrase) | No | No |
| **Works without another device** | Yes | Yes (recovery key) | No |

---

## Approach 1 — Old Thunderbolt (passphrase-based)

### How it worked

The user chose a passphrase during sync setup. That passphrase was fed into PBKDF2 (310,000 iterations, SHA-256) to derive a 256-bit AES master key. Because PBKDF2 is deterministic, the same passphrase and salt always produced the same key — meaning the user could re-derive their key on any new device just by entering the passphrase again.

A recovery key (the raw key bytes encoded as hex) was shown once at setup as a fallback in case the passphrase was forgotten.

```
passphrase + salt → PBKDF2 → master key → wraps content key → encrypts data
```

### What it got right

- Fully zero-knowledge — the server never touched the master key.
- Self-contained — a user with their passphrase could set up any new device independently, with no other device or server assistance required.
- Well-understood cryptography — PBKDF2-based key derivation is a proven pattern.

### Why we moved away from it

**Extra credential burden.** Users already authenticate with email + 2FA. Asking them to also manage a separate passphrase creates friction, especially since the passphrase serves a narrow technical purpose (key derivation) rather than a concept users naturally understand.

**Passphrase is a human-chosen secret.** Human-chosen secrets tend to be weak, reused, or forgotten. The security of the entire encryption model depended on the strength of something a person typed.

**Awkward recovery story.** If the user forgot their passphrase, the recovery key was the only fallback. If they lost both, data was gone forever. Users don't naturally understand why there are two secrets (passphrase and recovery key) and what each one is for.

**Key derivation is inflexible.** Because the master key was deterministically derived from the passphrase, changing the passphrase required a full key rotation — re-wrapping every record's content key. At scale this is a non-trivial operation.

**Race conditions with PowerSync.** Changing the passphrase changed the master key, which meant CK was re-wrapped for every record. This creates a window where some records on the server have been updated and some have not — a partial state that PowerSync can propagate to other devices mid-rotation, causing decryption failures.

---

## Approach 2 — New Thunderbolt (per-device keys + device approval)

### How it works

Each device generates its own random public/private key pair when the user enables sync for the first time. There is one content key (CK) that encrypts all data — the same value across all devices — but each device holds it wrapped in its own envelope, locked with that device's public key. Only that device's private key can unwrap it.

```
server holds:   envelope_1 = wrap(CK, pub_key_1)
                envelope_2 = wrap(CK, pub_key_2)
                envelope_3 = wrap(CK, pub_key_3)

device 1 holds: priv_key_1 → unwraps envelope_1 → CK
device 2 holds: priv_key_2 → unwraps envelope_2 → CK
device 3 holds: priv_key_3 → unwraps envelope_3 → CK
```

Adding a new device means creating a new envelope. A trusted device wraps CK with the new device's public key using `SubtleCrypto.wrapKey` — which handles the operation inside the browser's crypto engine, meaning raw CK bytes are never exposed to JavaScript — and sends the wrapped envelope to the server. Authentication uses the existing email + 2FA. The only user-managed secret is the recovery key — CK encoded as hex — shown once at first setup and used only if all devices are lost.

On the first device, CK is generated entirely on the FE. The server returns `{ status: APPROVAL_PENDING, firstDevice: true }` — it never generates or sees plaintext CK at any point, including during first setup. The `firstDevice` flag tells the FE to generate CK locally rather than wait for a trusted device to approve. This makes the model fully zero-knowledge with no caveats.

### What it gets right

- **Zero extra credentials.** The user's existing login is sufficient for all day-to-day operations. The recovery key is only needed in genuine emergencies.
- **Private keys are non-extractable.** Stored in IndexedDB as `CryptoKey` objects with `extractable: false` — raw bytes are never exposed to JavaScript. Even an XSS attack cannot steal key material, only misuse it within the current session.
- **Granular device revocation.** Revoking a compromised device only requires deleting its envelope. No global re-key, no disruption to other devices.
- **No race conditions with PowerSync.** CK itself never changes during normal operation. Envelopes are per-device and stored in a non-syncable server table. The sync layer and encryption layer are cleanly separated.
- **Structurally zero-knowledge.** The server holds only wrapped envelopes and ciphertext. It cannot decrypt data even if compelled or breached.

### The trade-offs

- Adding a new device requires a trusted device to be available or the recovery key as fallback. A user with neither is permanently locked out.
- The two-round-trip flow for first device setup (POST /devices then POST /devices/:id/envelope) is a minor complexity cost for a one-time operation.

---

## Approach 3 — Signal and WhatsApp

> The Signal Protocol is fully open source and extensively audited. The descriptions below are based on publicly available documentation and verifiable source code.
> 

### How it works

Signal uses the Signal Protocol — a ratcheting encryption scheme where every message has a unique key derived from the previous one. For multi-device support, each device generates its own key pair. Adding a new device requires scanning a QR code from an existing device — no server involvement at any point. The server never touches any key material.

WhatsApp uses the same protocol with a slightly more user-friendly device linking flow, but the same fundamental model: QR scan is mandatory, the server is never involved in key delivery.

### What it gets right

- Fully zero-knowledge — the server has no role in key delivery, ever.
- No recovery path means no recovery attack surface.
- Forward secrecy — past messages cannot be decrypted even if the current key is compromised.

### The trade-offs

- **No recovery.** Lose all devices and your message history is gone permanently. Signal accepts this explicitly as a security feature.
- **Mandatory physical proximity.** Adding a new device requires an existing device physically present. Independent onboarding is not possible.
- **Designed for mobile.** The QR flow works naturally on phones. On a desktop browser it is awkward — most users don't have a webcam pointed at their screen.

### Why Thunderbolt didn't follow this model

Thunderbolt is a web app used primarily on desktop, where QR scanning is a poor experience. More importantly, Thunderbolt's users expect account-level recovery — the "permanently locked out if you lose your phone" model is not appropriate for an AI assistant where users accumulate significant history over time.

---

## Why we chose the new Thunderbolt approach

The decision came down to five constraints specific to Thunderbolt:

**1. Web app, primarily desktop.** QR-based flows are designed for mobile cameras. Device approval via the Devices screen fits naturally into the web app UX without special hardware or timing requirements.

**2. PowerSync sync infrastructure.** The sync layer and encryption layer must not interfere with each other. The passphrase model changed CK on rotation, creating race conditions with PowerSync's continuous sync queue. Per-device envelopes stored in a non-syncable table eliminate this entirely — CK never changes under normal operation.

**3. Existing email + 2FA authentication.** We already have a strong authentication foundation. Building key delivery on top of credentials the user already has — rather than introducing a new passphrase — keeps the mental model simple and reduces the number of things that can go wrong.

**4. Non-extractable CryptoKey in IndexedDB.** The Web Crypto API allows storing key material as CryptoKey objects that JavaScript cannot read, only use. This gives meaningful protection against XSS without requiring a native app or platform keychain. The passphrase model required extractable keys (to derive and re-derive across sessions), which gave up this protection.

**5. Granular device trust.** Per-device keys mean a compromised device can be revoked without affecting any other device. The passphrase model had no equivalent — all devices shared the same derived key, so a passphrase compromise was a total compromise.

---

## What we traded away

Being explicit about trade-offs is important. The new approach is not strictly better in every dimension:

- **Losing all devices with no recovery key means permanent data loss.** This is true of Signal too, but it is a sharper edge than the passphrase model — which at least gave the user a second secret (the passphrase) to fall back on.
- **Device approval requires an active trusted device.** A user who has only ever had one device and loses it must use the recovery key. If they don't have it, data is gone. The passphrase model allowed independent re-derivation from the passphrase alone.
- **First device setup is two round trips instead of one.** A minor implementation complexity cost for a one-time operation.

These trade-offs are acceptable given Thunderbolt's context — a privacy-first product for users who expect account-level recovery, used primarily on desktop, built on a web platform with strong existing authentication.

---

## Summary

Thunderbolt's encryption model takes direct inspiration from the Signal Protocol's zero-knowledge guarantee while adapting it for a web app context where QR-based device linking is impractical and account-level recovery is expected. It is designed to be:

- **Fully zero-knowledge** — the server never sees plaintext CK at any point, including first device setup. CK is generated, wrapped, and canary-created entirely on the FE before anything reaches the server.
- **Invisible to the user** — no passphrase, no key management, no concepts to learn beyond saving the recovery key once.
- **Recoverable** — a recovery key exists so that losing all devices is not the end of the world.
- **Fit for a web app** — using Web Crypto, IndexedDB, and existing auth infrastructure rather than requiring native platform integration.
- **Compatible with PowerSync** — CK stability under normal operation means no encryption-related race conditions in the sync layer.