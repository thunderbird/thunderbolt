# CONTRACT-002: Seed Data and Hash Function

**Module:** `src/defaults/model-profiles.ts`
**Phase:** 1
**Depends on:** CONTRACT-001 (types must exist)
**Blocks:** CONTRACT-003

---

## Scope

Create the seed data file for the three built-in model profiles and the hash function used by reconcile-defaults.

## Deliverables

### 1. `src/defaults/model-profiles.ts`

```typescript
import { hashValues } from '@/lib/utils'
import type { ModelProfile } from '@/types'
import {
  defaultModelGptOss120b,
  defaultModelMistralMedium31,
  defaultModelSonnet45,
} from './models'

/**
 * Compute hash of user-editable fields for a model profile.
 * Used by reconcile-defaults to detect user modifications.
 */
export const hashModelProfile = (profile: ModelProfile): string =>
  hashValues([
    profile.modelId,
    profile.temperature,
    profile.maxSteps,
    profile.maxAttempts,
    profile.useSystemMessageModeDeveloper,
    profile.finalStepNudge,
    profile.preventiveNudge,
    profile.retryNudge,
    profile.searchFinalStepNudge,
    profile.searchPreventiveNudge,
    profile.searchRetryNudge,
    profile.deletedAt,
  ])
```

Generate UUIDs with `uuidv7()` for the profile IDs. The seed profiles:

**GPT OSS profile:**
- `temperature: 20` (0.2)
- `maxSteps: 20`
- `maxAttempts: 2`
- `useSystemMessageModeDeveloper: 1` (this is the key behavioral flag)
- All nudge fields: `null`

**Mistral Medium 3.1 profile:**
- `temperature: 20` (0.2)
- `maxSteps: 20`
- `maxAttempts: 2`
- `useSystemMessageModeDeveloper: 0`
- All nudge fields: `null`

**Sonnet 4.5 profile:**
- `temperature: 20` (0.2)
- `maxSteps: 20`
- `maxAttempts: 2`
- `useSystemMessageModeDeveloper: 0`
- All nudge fields: `null`

Export `defaultModelProfiles: ReadonlyArray<ModelProfile>` containing all three.

## Key Constraints

- Profile IDs must be generated once and hardcoded (same as model IDs in `defaults/models.ts`). Use `uuidv7()` to generate them at development time, then paste the values.
- `defaultHash: null` on seed data -- the reconcile function computes and sets this on first insert.
- `deletedAt: null` on all seed profiles.
- The `modelId` values must reference the existing model IDs from `defaults/models.ts`.

## Acceptance Criteria

- [ ] `hashModelProfile` is exported and produces deterministic hashes
- [ ] `defaultModelProfiles` contains exactly 3 profiles
- [ ] GPT OSS profile has `useSystemMessageModeDeveloper: 1`
- [ ] Mistral and Sonnet profiles have `useSystemMessageModeDeveloper: 0`
- [ ] All `modelId` values match the corresponding model's `id` in `defaults/models.ts`
- [ ] All nudge fields are `null` (use application defaults)
- [ ] `bun test` passes (no type errors)
