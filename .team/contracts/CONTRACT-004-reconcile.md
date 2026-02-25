# CONTRACT-004: Reconcile Defaults Integration

**Module:** `src/lib/reconcile-defaults.ts`
**Phase:** 1
**Depends on:** CONTRACT-001 (schema), CONTRACT-002 (seed data)
**Blocks:** Nothing (but must be done before Phase 2)

---

## Scope

Add model profiles to the reconcile-defaults startup mechanism. This is a minimal change -- one import and one function call.

## Deliverables

### 1. `src/lib/reconcile-defaults.ts`

Add imports:
```typescript
import { defaultModelProfiles, hashModelProfile } from '../defaults/model-profiles'
import { modelProfilesTable } from '../db/tables'
```

Add reconcile call **immediately after the models line** (FK dependency):
```typescript
export const reconcileDefaults = async (db: AnyDrizzleDatabase) => {
  // AI models
  await reconcileDefaultsForTable(db, modelsTable, defaultModels, hashModel)

  // Model profiles (must be after models due to FK)
  await reconcileDefaultsForTable(db, modelProfilesTable, defaultModelProfiles, hashModelProfile)

  // Modes
  await reconcileDefaultsForTable(db, modesTable, defaultModes, hashMode)

  // ... rest unchanged
}
```

## Key Constraints

- The profile reconcile MUST come after models and before modes. This is because profiles have a FK to models. If models are not yet inserted, the FK constraint would fail.
- No changes to `reconcileDefaultsForTable` itself. The generic function works unchanged.
- The `wouldOverwriteUserValue` guard (line 51) does not apply to profiles because profiles do not have a `value` column. The check is safely skipped via the `(existing as any).value !== null` condition.

## Acceptance Criteria

- [ ] Profiles are reconciled in the correct order (after models, before modes)
- [ ] App starts cleanly and `model_profiles` table has 3 rows with `defaultHash` set
- [ ] Modifying a profile in the DB and restarting preserves the modification (hash mismatch)
- [ ] Restoring a profile to default values and restarting updates it to latest defaults
- [ ] No changes to `reconcileDefaultsForTable` function
