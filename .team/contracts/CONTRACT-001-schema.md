# CONTRACT-001: Database Schema

**Module:** `src/db/tables.ts`, `src/db/relations.ts`, `src/types.ts`
**Phase:** 1
**Depends on:** Nothing
**Blocks:** CONTRACT-002, CONTRACT-003, CONTRACT-004

---

## Scope

Add the `modelProfilesTable` definition, relation, and TypeScript types.

## Deliverables

### 1. `src/db/tables.ts` -- Add table

Add `modelProfilesTable` after `modelsTable`:

```typescript
export const modelProfilesTable = sqliteTable(
  'model_profiles',
  {
    id: text('id').primaryKey().notNull().unique(),
    modelId: text('model_id')
      .notNull()
      .unique()
      .references(() => modelsTable.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    temperature: integer('temperature').default(20),
    maxSteps: integer('max_steps').default(20),
    maxAttempts: integer('max_attempts').default(2),
    useSystemMessageModeDeveloper: integer('use_system_message_mode_developer').default(0),
    finalStepNudge: text('final_step_nudge'),
    preventiveNudge: text('preventive_nudge'),
    retryNudge: text('retry_nudge'),
    searchFinalStepNudge: text('search_final_step_nudge'),
    searchPreventiveNudge: text('search_preventive_nudge'),
    searchRetryNudge: text('search_retry_nudge'),
    defaultHash: text('default_hash'),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    index('idx_model_profiles_active')
      .on(table.modelId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
)
```

### 2. `src/db/relations.ts` -- Add relation

```typescript
import { modelProfilesTable } from './tables'

export const modelProfilesRelations = relations(modelProfilesTable, ({ one }) => ({
  model: one(modelsTable, {
    fields: [modelProfilesTable.modelId],
    references: [modelsTable.id],
  }),
}))
```

Update `modelsRelations` to include the reverse relation:

```typescript
export const modelsRelations = relations(modelsTable, ({ many, one }) => ({
  chatMessages: many(chatMessagesTable),
  profile: one(modelProfilesTable),
}))
```

### 3. `src/types.ts` -- Add types

Add import for `modelProfilesTable` to the existing import block, then add:

```typescript
export type ModelProfileRow = InferSelectModel<typeof modelProfilesTable>
export type ModelProfile = WithRequired<ModelProfileRow, 'modelId' | 'maxSteps' | 'maxAttempts'>
```

### 4. Generate migration

Run `bun db generate` to create the SQL migration file. Do NOT manually write SQL.

## Acceptance Criteria

- [ ] `modelProfilesTable` is exported from `src/db/tables.ts`
- [ ] `modelProfilesRelations` is exported from `src/db/relations.ts`
- [ ] `ModelProfile` and `ModelProfileRow` types are exported from `src/types.ts`
- [ ] Migration file is generated in `drizzle/` directory
- [ ] `bun test` passes (no type errors)
- [ ] The table has a partial index on `modelId` filtered by `deletedAt IS NULL`
- [ ] FK references `modelsTable.id` with cascade delete/update
