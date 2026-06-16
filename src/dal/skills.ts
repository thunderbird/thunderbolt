/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { skillsTable } from '../db/tables'
import type { DrizzleQueryWithPromise, Skill } from '../types'
import { nowIso } from '../lib/utils'

/** Maximum pinned skills per user (spec §Scope). */
export const maxPinnedSkills = 10

/** Returned when a write would create two skills with the same `name`. */
export class SkillNameTakenError extends Error {
  constructor(public readonly skillName: string) {
    super(`A skill named "${skillName}" already exists.`)
    this.name = 'SkillNameTakenError'
  }
}

/** Returned when a skill name fails the AgentSkills spec validation. */
export class SkillNameInvalidError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'SkillNameInvalidError'
  }
}

/** Returned when pinning would exceed the {@link maxPinnedSkills} cap. */
export class PinLimitExceededError extends Error {
  constructor() {
    super(`Pinned skill limit reached (${maxPinnedSkills}). Unpin one to add another.`)
    this.name = 'PinLimitExceededError'
  }
}

const maxSkillNameLength = 64

/**
 * Validate a skill name against the [AgentSkills spec](https://agentskills.io/specification#name-field):
 * 1–64 chars; lowercase a–z, 0–9, hyphens only; no leading/trailing hyphen;
 * no consecutive hyphens.
 *
 * Names are stored as bare slugs (no leading `/`). The slash is a chat
 * trigger added at display + parse time only, not part of the data.
 *
 * @returns A human-readable error string when invalid, or `null` when valid.
 */
export const validateSkillName = (slug: string): string | null => {
  if (slug.length === 0) {
    return 'Name is required.'
  }
  if (slug.length > maxSkillNameLength) {
    return `Name must be ${maxSkillNameLength} characters or fewer.`
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return 'Name may only contain lowercase letters, numbers, and hyphens.'
  }
  if (slug.startsWith('-') || slug.endsWith('-')) {
    return 'Name cannot start or end with a hyphen.'
  }
  if (slug.includes('--')) {
    return 'Name cannot contain consecutive hyphens.'
  }
  return null
}

/**
 * Drizzle query for all non-deleted skills in the given workspace, ordered by name.
 * Use with PowerSync's `toCompilableQuery` or `await` for a one-shot read.
 */
export const getAllSkills = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = db
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.workspaceId, workspaceId), isNull(skillsTable.deletedAt)))
    .orderBy(asc(skillsTable.name))

  return query as typeof query & DrizzleQueryWithPromise<Skill>
}

/** Drizzle query for pinned skills in the given workspace (non-null `pinned_order`), ordered by `pinned_order`. */
export const getPinnedSkills = (db: AnyDrizzleDatabase, workspaceId: string) => {
  const query = db
    .select()
    .from(skillsTable)
    .where(
      and(eq(skillsTable.workspaceId, workspaceId), isNull(skillsTable.deletedAt), isNotNull(skillsTable.pinnedOrder)),
    )
    .orderBy(asc(skillsTable.pinnedOrder))

  return query as typeof query & DrizzleQueryWithPromise<Skill>
}

/** One-shot read of a single non-deleted skill by id in the given workspace. */
export const getSkill = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<Skill | null> => {
  const row = await db
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.id, id), eq(skillsTable.workspaceId, workspaceId), isNull(skillsTable.deletedAt)))
    .get()
  return (row ?? null) as Skill | null
}

/** One-shot read of a single non-deleted skill by name in the given workspace (case-sensitive). */
export const getSkillByName = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  name: string,
): Promise<Skill | null> => {
  const row = await db
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.name, name), eq(skillsTable.workspaceId, workspaceId), isNull(skillsTable.deletedAt)))
    .get()
  return (row ?? null) as Skill | null
}

const assertNameAvailable = async (db: AnyDrizzleDatabase, workspaceId: string, name: string, excludeId?: string) => {
  // Soft-deleted rows have `name = NULL` after `softDeleteSkill`, so
  // `name = ?` already excludes tombstones — no extra deleted_at filter needed.
  const existing = await db
    .select({ id: skillsTable.id })
    .from(skillsTable)
    .where(
      excludeId
        ? and(eq(skillsTable.workspaceId, workspaceId), eq(skillsTable.name, name), ne(skillsTable.id, excludeId))
        : and(eq(skillsTable.workspaceId, workspaceId), eq(skillsTable.name, name)),
    )
    .get()
  if (existing) {
    throw new SkillNameTakenError(name)
  }
}

const countPinned = async (db: AnyDrizzleDatabase, workspaceId: string, excludeId?: string): Promise<number> => {
  const rows = await db
    .select({ id: skillsTable.id })
    .from(skillsTable)
    .where(
      excludeId
        ? and(
            eq(skillsTable.workspaceId, workspaceId),
            isNull(skillsTable.deletedAt),
            isNotNull(skillsTable.pinnedOrder),
            ne(skillsTable.id, excludeId),
          )
        : and(
            eq(skillsTable.workspaceId, workspaceId),
            isNull(skillsTable.deletedAt),
            isNotNull(skillsTable.pinnedOrder),
          ),
    )
  return rows.length
}

export type CreateSkillInput = {
  name: string
  description: string
  instruction: string
}

/**
 * Insert a new skill in the given workspace. Throws {@link SkillNameInvalidError}
 * if `name` fails the AgentSkills spec, or {@link SkillNameTakenError} if it
 * collides with another skill in the workspace.
 */
export const createSkill = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  input: CreateSkillInput,
): Promise<Skill> => {
  const nameError = validateSkillName(input.name)
  if (nameError) {
    throw new SkillNameInvalidError(nameError)
  }
  await assertNameAvailable(db, workspaceId, input.name)
  const row: Skill = {
    id: uuidv7(),
    name: input.name,
    description: input.description,
    instruction: input.instruction,
    enabled: 1,
    pinnedOrder: null,
    deletedAt: null,
    defaultHash: null,
    userId: null,
    workspaceId,
  }
  await db.insert(skillsTable).values(row)
  return row
}

export type UpdateSkillInput = Partial<Pick<Skill, 'name' | 'description' | 'instruction'>>

/**
 * Patch an existing skill in the given workspace. Throws {@link SkillNameInvalidError}
 * if `name` fails the AgentSkills spec, or {@link SkillNameTakenError} if it
 * collides with another skill in the workspace.
 */
export const updateSkill = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  patch: UpdateSkillInput,
): Promise<void> => {
  if (patch.name !== undefined) {
    const nameError = validateSkillName(patch.name)
    if (nameError) {
      throw new SkillNameInvalidError(nameError)
    }
    await assertNameAvailable(db, workspaceId, patch.name, id)
  }
  await db
    .update(skillsTable)
    .set(patch)
    .where(and(eq(skillsTable.id, id), eq(skillsTable.workspaceId, workspaceId)))
}

/**
 * Soft-delete a skill: set `deleted_at` and wipe user content (`name`, `description`, `instruction`).
 * The tombstone (`id`, `user_id`, `deleted_at`) remains so PowerSync propagates the delete to other devices.
 */
export const softDeleteSkill = async (db: AnyDrizzleDatabase, workspaceId: string, id: string): Promise<void> => {
  await db
    .update(skillsTable)
    .set({
      name: null,
      description: null,
      instruction: null,
      pinnedOrder: null,
      deletedAt: nowIso(),
    })
    .where(and(eq(skillsTable.id, id), eq(skillsTable.workspaceId, workspaceId), isNull(skillsTable.deletedAt)))
}

/**
 * Pin or unpin a skill. Pass `null` to unpin. Pass a number to set the pin position.
 * Throws {@link PinLimitExceededError} if pinning would exceed {@link maxPinnedSkills}.
 */
export const setPinned = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  order: number | null,
): Promise<void> => {
  if (order !== null) {
    const pinned = await countPinned(db, workspaceId, id)
    if (pinned >= maxPinnedSkills) {
      throw new PinLimitExceededError()
    }
  }
  await db
    .update(skillsTable)
    .set({ pinnedOrder: order })
    .where(and(eq(skillsTable.id, id), eq(skillsTable.workspaceId, workspaceId)))
}

/** Toggle the `enabled` flag. SkillsView auto-unpins on disable as a side-effect at the call site. */
export const setEnabled = async (
  db: AnyDrizzleDatabase,
  workspaceId: string,
  id: string,
  next: boolean,
): Promise<void> => {
  await db
    .update(skillsTable)
    .set({ enabled: next ? 1 : 0 })
    .where(and(eq(skillsTable.id, id), eq(skillsTable.workspaceId, workspaceId)))
}

/**
 * Rewrite the `pinned_order` of the supplied ids in a single transaction (index = position).
 * Ids not in the list keep their existing order. Bounded by the 10-pin cap.
 */
export const reorderPins = async (db: AnyDrizzleDatabase, workspaceId: string, ids: string[]): Promise<void> => {
  if (ids.length === 0) {
    return
  }
  if (ids.length > maxPinnedSkills) {
    throw new PinLimitExceededError()
  }
  await db.transaction(async (tx) => {
    // Two-phase update to avoid hitting the (id, pinned_order) collision space
    // mid-rewrite: stage everything to negative ordinals first, then settle.
    for (let i = 0; i < ids.length; i++) {
      await tx
        .update(skillsTable)
        .set({ pinnedOrder: sql`${-1 - i}` })
        .where(and(eq(skillsTable.id, ids[i]!), eq(skillsTable.workspaceId, workspaceId)))
    }
    for (let i = 0; i < ids.length; i++) {
      await tx
        .update(skillsTable)
        .set({ pinnedOrder: i })
        .where(and(eq(skillsTable.id, ids[i]!), eq(skillsTable.workspaceId, workspaceId)))
    }
  })
}

/** Bulk lookup by id in the given workspace, excluding soft-deleted rows. */
export const getSkillsByIds = async (db: AnyDrizzleDatabase, workspaceId: string, ids: string[]): Promise<Skill[]> => {
  if (ids.length === 0) {
    return []
  }
  const rows = await db
    .select()
    .from(skillsTable)
    .where(and(inArray(skillsTable.id, ids), eq(skillsTable.workspaceId, workspaceId), isNull(skillsTable.deletedAt)))
  return rows as Skill[]
}
