# CONTRACT-003: Data Access Layer

**Module:** `src/dal/model-profiles.ts`, `src/dal/model-profiles.test.ts`, `src/dal/index.ts`
**Phase:** 1
**Depends on:** CONTRACT-001 (schema), CONTRACT-002 (seed data for tests)
**Blocks:** CONTRACT-005

---

## Scope

Create the DAL module for model profiles with CRUD operations, and update existing DAL modules for integration.

## Deliverables

### 1. `src/dal/model-profiles.ts`

Follow the exact patterns in `src/dal/modes.ts` and `src/dal/models.ts`.

#### Functions to implement:

```typescript
/**
 * Gets the profile for a model by modelId (excluding soft-deleted).
 * Returns null if no profile exists.
 */
export const getModelProfile = async (modelId: string): Promise<ModelProfile | null>

/**
 * Upserts a model profile. Accepts float temperature (0.0-2.0) and
 * converts to integer encoding internally.
 * Does NOT update defaultHash (preserves modification tracking).
 */
export const upsertModelProfile = async (
  id: string,
  data: Partial<Omit<ModelProfile, 'id' | 'defaultHash'>>,
): Promise<void>

/**
 * Resets a profile to its default state.
 * Used by the UI "Reset to default" button.
 */
export const resetModelProfileToDefault = async (
  modelId: string,
  defaultProfile: ModelProfile,
  hashFn: (profile: ModelProfile) => string,
): Promise<void>

/**
 * Soft-deletes a model profile by modelId.
 * Called when a model is soft-deleted.
 */
export const deleteModelProfileForModel = async (modelId: string): Promise<void>

/**
 * Creates a default profile for a newly-created model.
 * Uses neutral defaults (all flags off, null nudges, null defaultHash).
 */
export const createDefaultModelProfile = async (modelId: string): Promise<void>
```

#### Temperature conversion:

The `getModelProfile` function returns the raw integer encoding (e.g., 20). The consumer in `fetch.ts` divides by 100 to get the float. This keeps the DAL simple and avoids hiding the encoding.

The `upsertModelProfile` function (used by the UI) should accept the integer encoding directly. The UI form is responsible for the conversion, matching how the UI handles other integer-encoded fields.

### 2. `src/dal/models.ts` -- Update `createModel`

After inserting the model row, call `createDefaultModelProfile(data.id)` to auto-create a profile.

After `deletePromptsForModel(id)` in `deleteModel`, call `deleteModelProfileForModel(id)` to soft-delete the profile.

### 3. `src/dal/index.ts` -- Re-export

Add:
```typescript
// Model Profiles
export {
  createDefaultModelProfile,
  deleteModelProfileForModel,
  getModelProfile,
  resetModelProfileToDefault,
  upsertModelProfile,
} from './model-profiles'
```

### 4. `src/dal/model-profiles.test.ts`

Test cases:

- `getModelProfile` returns null when no profile exists
- `getModelProfile` returns the profile after seed data is reconciled
- `getModelProfile` filters out soft-deleted profiles
- `upsertModelProfile` creates a new profile
- `upsertModelProfile` updates an existing profile
- `deleteModelProfileForModel` soft-deletes and profile is no longer returned
- `createDefaultModelProfile` creates a profile with neutral defaults
- `resetModelProfileToDefault` restores seed values and re-stamps defaultHash

Follow the testing pattern used in existing DAL tests (check `src/dal/` for existing `.test.ts` files to match the setup/teardown pattern).

## Acceptance Criteria

- [ ] All 5 DAL functions implemented and exported
- [ ] `getModelProfile` queries by `modelId` (not by profile `id`)
- [ ] Soft-deleted profiles are filtered with `isNull(deletedAt)`
- [ ] `deleteModel` in `models.ts` cascades to profile soft-delete
- [ ] `createModel` in `models.ts` auto-creates a default profile
- [ ] All test cases pass with `bun test src/dal/model-profiles.test.ts`
- [ ] No TypeScript errors
