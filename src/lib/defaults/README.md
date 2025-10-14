# Defaults Management System

## Overview

This system provides a unified pattern for managing application defaults (models, automations) with user override tracking and restore capabilities.

## Architecture

### Core Principles

1. **TypeScript Constants as Source of Truth** - All defaults defined in type-safe TS files
2. **Database as Runtime Source** - Always query DB, never read from TS at runtime (except diffing)
3. **Hash-based Change Detection** - Automatically detect user modifications without explicit flags
4. **Automatic Updates** - Unmodified defaults get updated on app start, user changes are preserved

### How It Works

**defaultHash Column:**

- Stores the hash of the DEFAULT content (not current content)
- Set once when default is seeded
- Never changes unless user resets or row is re-seeded
- `null` for user-created items

**On App Start (Seed):**

```typescript
for (const default of defaults) {
  if (!exists) {
    insert(default) // includes defaultHash
  } else {
    currentHash = hash(existing.content)
    if (currentHash === existing.defaultHash) {
      update(default) // unmodified, safe to update
    }
    // else: user modified, skip
  }
}
```

**User Edits:**

```typescript
// Just update content fields, don't touch defaultHash
update({ title, prompt, modelId })
```

**Show Modification Indicator:**

```typescript
const currentHash = hashPrompt(prompt)
const isModified = currentHash !== prompt.defaultHash
// Show blue dot if isModified
```

**Reset to Default:**

```typescript
update(default) // includes original defaultHash
// Now currentHash === defaultHash again
```

## Files

### `/defaults/models.ts`

- Individual exports: `defaultModelQwen3Flower`, etc.
- Array export: `defaultModels`
- Each model includes pre-computed `defaultHash`

### `/defaults/automations.ts`

- Individual exports: `defaultAutomationDailyBrief`, etc.
- Array export: `defaultAutomations`
- References models directly: `modelId: defaultModelQwen3Flower.id`
- Each automation includes pre-computed `defaultHash`

### `/defaults-hash.ts`

- `hashModel(model)` - Hashes user-editable model fields
- `hashPrompt(prompt)` - Hashes user-editable prompt fields
- Uses simple hash algorithm (not cryptographic)

### `/defaults-reset.ts`

- `resetModelToDefault(id, default)` - Resets a model
- `resetAutomationToDefault(id, default)` - Resets an automation

### `/seed.ts`

- `seedModels()` - Conditional insert/update based on hash
- `seedPrompts()` - Conditional insert/update based on hash

## Schema

### models table

```sql
default_hash TEXT -- Hash of default content, null for user-created
deleted_at INTEGER -- Soft delete timestamp
```

### prompts table

```sql
default_hash TEXT -- Hash of default content, null for user-created
deleted_at INTEGER -- Soft delete timestamp
```

## Adding a New Default

### New Model:

```typescript
// In defaults/models.ts
export const defaultModelNewModel: Model = {
  id: uuidv7(), // Generate and hardcode
  name: 'New Model',
  // ... all fields including apiKey: null, url: null
}

const base = { ...defaultModelNewModel }
delete base.defaultHash
export const defaultModelNewModel: Model = {
  ...base,
  defaultHash: hashModel(base),
}

// Add to array
export const defaultModels = [..., defaultModelNewModel]
```

### New Automation:

```typescript
// In defaults/automations.ts
const base = {
  id: uuidv7(), // Generate and hardcode
  title: 'New Automation',
  prompt: '...',
  modelId: defaultModelQwen3Flower.id,
  deletedAt: null,
}

export const defaultAutomationNew: Prompt = {
  ...base,
  defaultHash: hashPrompt(base),
}

// Add to array
export const defaultAutomations = [..., defaultAutomationNew]
```

## Updating a Default

1. Edit the default in TypeScript
2. Update the hash (happens automatically due to constant re-evaluation)
3. On next app start:
   - Users with unmodified default get the update
   - Users who modified it keep their version (blue dot appears)

## Testing

Run: `bun test src/lib/defaults*.test.ts src/lib/seed.test.ts`

**Test Coverage:**

- ✅ Hash consistency and change detection
- ✅ Seed inserts new defaults
- ✅ Seed preserves user modifications
- ✅ Seed handles mixed scenarios
- ✅ Reset restores defaults correctly
- ✅ Round-trip modification detection (change and change back)

**22 tests, all passing**

## Benefits

- ✅ Simple: Just one column (`defaultHash`)
- ✅ Type-safe: Defaults implement full types
- ✅ Automatic: No manual version tracking
- ✅ Correct: Detects round-trip modifications
- ✅ User-friendly: Shows modification indicator, allows reset
- ✅ Future-proof: Easy to add/update defaults
