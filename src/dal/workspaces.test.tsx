/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import {
  chatMessagesTable,
  chatThreadsTable,
  mcpServersTable,
  modelProfilesTable,
  modelsTable,
  modesTable,
  promptsTable,
  skillsTable,
  tasksTable,
  triggersTable,
  workspaceMembershipsTable,
  workspacePendingMembershipsTable,
  workspacesTable,
} from '@/db/tables'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  addPendingMemberships,
  createSharedWorkspace,
  duplicateWorkspace,
  getWorkspacesForUserQuery,
  updateWorkspace,
  useWorkspacesQuery,
} from './workspaces'
import { otherWsId, resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from './test-utils'

const DbWrapper = ({ children }: { children: ReactNode }) => (
  <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>
)

const seedSharedWorkspace = async (id: string, name: string, ownerUserId: string, members: string[]) => {
  const db = getDb()
  await db.insert(workspacesTable).values({
    id,
    name,
    isPersonal: 0,
    ownerUserId,
  })
  for (const userId of members) {
    await db.insert(workspaceMembershipsTable).values({
      id: `${id}-${userId}`,
      workspaceId: id,
      userId,
      role: 'admin',
    })
  }
}

describe('getWorkspacesForUserQuery', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    // Personal workspace seeded by setup, but its membership row is not — seed it.
    const db = getDb()
    await db.insert(workspaceMembershipsTable).values({
      id: `${wsId}-${testUserId}`,
      workspaceId: wsId,
      userId: testUserId,
      role: 'admin',
    })
  })

  it('returns only workspaces the user is a member of', async () => {
    await seedSharedWorkspace(otherWsId, 'Acme', testUserId, [testUserId])
    await seedSharedWorkspace('foreign-ws', 'Foreign', 'someone-else', ['someone-else'])

    const rows = await getWorkspacesForUserQuery(getDb(), testUserId).execute()
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(wsId)
    expect(ids).toContain(otherWsId)
    expect(ids).not.toContain('foreign-ws')
  })

  it('sorts personal first, then alpha by name', async () => {
    await seedSharedWorkspace(otherWsId, 'Acme', testUserId, [testUserId])
    await seedSharedWorkspace('z-team', 'Zebra Team', testUserId, [testUserId])
    await seedSharedWorkspace('b-team', 'Beta Co', testUserId, [testUserId])

    const rows = await getWorkspacesForUserQuery(getDb(), testUserId).execute()
    // Personal first (isPersonal=1 wins over isPersonal=0 due to DESC).
    expect(rows[0].id).toBe(wsId)
    // Then alpha by name across the shared rows.
    const sharedNames = rows.slice(1).map((r) => r.name)
    expect(sharedNames).toEqual(['Acme', 'Beta Co', 'Zebra Team'])
  })
})

describe('useWorkspacesQuery', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    seedTestTrustDomain()
    const db = getDb()
    await db.insert(workspaceMembershipsTable).values({
      id: `${wsId}-${testUserId}`,
      workspaceId: wsId,
      userId: testUserId,
      role: 'admin',
    })
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  const Probe = () => {
    const workspaces = useWorkspacesQuery()
    if (workspaces.length === 0) {
      return null
    }
    return (
      <ul>
        {workspaces.map((ws) => (
          <li key={ws.id} data-testid={`ws-row-${ws.id}`}>
            {ws.name}
          </li>
        ))}
      </ul>
    )
  }

  it('returns personal-first ordering, excludes non-member workspaces', async () => {
    await seedSharedWorkspace(otherWsId, 'Acme', testUserId, [testUserId])
    await seedSharedWorkspace('foreign-ws', 'Foreign', 'someone-else', ['someone-else'])

    renderWithReactivity(<Probe />, {
      tables: ['workspaces', 'workspace_memberships'],
      wrapper: DbWrapper,
    })

    await waitForElement(() => screen.queryByTestId(`ws-row-${otherWsId}`))
    expect(screen.getByTestId(`ws-row-${wsId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`ws-row-${otherWsId}`)).toBeInTheDocument()
    expect(screen.queryByTestId('ws-row-foreign-ws')).not.toBeInTheDocument()
  })
})

describe('createSharedWorkspace', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('creates a workspace + admin membership with no invites', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Engineering',
    })

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws).toHaveLength(1)
    expect(ws[0].name).toBe('Engineering')
    expect(ws[0].isPersonal).toBe(0)
    expect(ws[0].ownerUserId).toBeNull()

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.workspaceId, workspaceId))
    expect(memberships).toHaveLength(1)
    expect(memberships[0].userId).toBe(testUserId)
    expect(memberships[0].role).toBe('admin')

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending).toHaveLength(0)
  })

  it('trims the workspace name', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: '   Trimmed Team   ',
    })
    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws[0].name).toBe('Trimmed Team')
  })

  it('throws on empty / whitespace-only name', async () => {
    const db = getDb()
    await expect(createSharedWorkspace(db, { creatorUserId: testUserId, name: '   ' })).rejects.toThrow(
      /name is required/i,
    )
  })

  it('writes one pending row per invited email + assigns inviter id', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Acme',
      invitedEmails: ['a@test.com', 'b@test.com'],
    })

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending).toHaveLength(2)
    const emails = pending.map((p) => p.email).sort()
    expect(emails).toEqual(['a@test.com', 'b@test.com'])
    for (const row of pending) {
      expect(row.invitedByUserId).toBe(testUserId)
      expect(row.role).toBe('member')
    }
  })

  it('normalizes (lowercase + trim) and dedupes invited emails', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Norm',
      invitedEmails: [' Alice@test.com', 'alice@TEST.com  ', 'bob@test.com', ''],
    })

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    const emails = pending.map((p) => p.email).sort()
    expect(emails).toEqual(['alice@test.com', 'bob@test.com'])
  })

  it('drops the creator email from the invite list', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      creatorEmail: 'creator@test.com',
      name: 'Self-invite test',
      invitedEmails: [' Creator@test.com', 'other@test.com'],
    })

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending.map((p) => p.email)).toEqual(['other@test.com'])
  })

  it('honors inviteRole override', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Admins',
      invitedEmails: ['lead@test.com'],
      inviteRole: 'admin',
    })

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending[0].role).toBe('admin')
  })

  it('seeds default models / modes / skills / tasks / profiles for the new workspace', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Seeded',
    })

    const models = await db.select().from(modelsTable).where(eq(modelsTable.workspaceId, workspaceId))
    const modes = await db.select().from(modesTable).where(eq(modesTable.workspaceId, workspaceId))
    const skills = await db.select().from(skillsTable).where(eq(skillsTable.workspaceId, workspaceId))
    const tasks = await db.select().from(tasksTable).where(eq(tasksTable.workspaceId, workspaceId))
    const profiles = await db.select().from(modelProfilesTable).where(eq(modelProfilesTable.workspaceId, workspaceId))

    expect(models.length).toBeGreaterThan(0)
    expect(modes.length).toBeGreaterThan(0)
    expect(skills.length).toBeGreaterThan(0)
    expect(tasks.length).toBeGreaterThan(0)
    expect(profiles.length).toBeGreaterThan(0)
  })
})

describe('addPendingMemberships', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('writes one pending row per email + returns the count', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'For-invites',
    })

    const written = await addPendingMemberships(db, {
      workspaceId,
      invitedByUserId: testUserId,
      emails: ['a@test.com', 'b@test.com'],
    })
    expect(written).toBe(2)

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending.map((p) => p.email).sort()).toEqual(['a@test.com', 'b@test.com'])
    for (const row of pending) {
      expect(row.invitedByUserId).toBe(testUserId)
      expect(row.role).toBe('member')
    }
  })

  it('normalizes + dedupes + filters out the creator email', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Norm-invites',
    })

    const written = await addPendingMemberships(db, {
      workspaceId,
      invitedByUserId: testUserId,
      creatorEmail: 'me@test.com',
      emails: [' Me@test.com', ' me@TEST.com ', 'Friend@test.com', 'friend@test.com'],
    })
    expect(written).toBe(1)

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending.map((p) => p.email)).toEqual(['friend@test.com'])
  })

  it('returns 0 + writes nothing when the email list is empty', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Empty-invites',
    })

    const written = await addPendingMemberships(db, {
      workspaceId,
      invitedByUserId: testUserId,
      emails: [],
    })
    expect(written).toBe(0)

    const pending = await db
      .select()
      .from(workspacePendingMembershipsTable)
      .where(eq(workspacePendingMembershipsTable.workspaceId, workspaceId))
    expect(pending).toHaveLength(0)
  })
})

describe('updateWorkspace', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  it('updates the workspace name on the row', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Old name',
    })

    await updateWorkspace(db, workspaceId, { name: 'New name' })

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws[0].name).toBe('New name')
  })

  it('trims whitespace before writing', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Old',
    })

    await updateWorkspace(db, workspaceId, { name: '   Trimmed   ' })

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws[0].name).toBe('Trimmed')
  })

  it('throws on empty / whitespace-only name', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Untouched',
    })

    await expect(updateWorkspace(db, workspaceId, { name: '   ' })).rejects.toThrow(/name is required/i)

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws[0].name).toBe('Untouched')
  })

  it('stamps updatedAt', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Stampme',
    })

    await updateWorkspace(db, workspaceId, { name: 'Stamped' })

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws[0].updatedAt).toBeTruthy()
    expect(() => new Date(ws[0].updatedAt as string).toISOString()).not.toThrow()
  })

  it('writes slug + icon when present', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Acme',
    })

    await updateWorkspace(db, workspaceId, { slug: 'acme', icon: '🛠️' })

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws[0].slug).toBe('acme')
    expect(ws[0].icon).toBe('🛠️')
    expect(ws[0].name).toBe('Acme')
  })

  it('clears slug + icon when explicitly set to null', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Acme',
    })
    await updateWorkspace(db, workspaceId, { slug: 'acme', icon: '🛠️' })

    await updateWorkspace(db, workspaceId, { slug: null, icon: null })

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(ws[0].slug).toBeNull()
    expect(ws[0].icon).toBeNull()
  })

  it('skips the write when the patch is empty', async () => {
    const db = getDb()
    const workspaceId = await createSharedWorkspace(db, {
      creatorUserId: testUserId,
      name: 'Untouched',
    })
    const before = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))

    await updateWorkspace(db, workspaceId, {})

    const after = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
    expect(after[0].updatedAt).toBe(before[0].updatedAt)
  })
})

describe('duplicateWorkspace', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  /**
   * Create a bare source workspace + admin membership without seeding the
   * default models/skills/etc. The duplicate tests assert clone counts, which
   * would otherwise include the auto-seeded defaults from `createSharedWorkspace`.
   */
  const seedBareSourceWorkspace = async (id = 'source-ws') => {
    const db = getDb()
    await db.insert(workspacesTable).values({
      id,
      name: 'Source',
      isPersonal: 0,
      ownerUserId: null,
    })
    await db.insert(workspaceMembershipsTable).values({
      id: `${id}-${testUserId}`,
      workspaceId: id,
      userId: testUserId,
      role: 'admin',
    })
    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, id))
    return ws[0]
  }

  it('creates a new shared workspace + admin membership for the creator', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()

    const newId = await duplicateWorkspace(db, source, {
      creatorUserId: testUserId,
      name: 'Source Copy',
    })

    expect(newId).not.toBe(source.id)
    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, newId))
    expect(ws[0].name).toBe('Source Copy')
    expect(ws[0].isPersonal).toBe(0)

    const memberships = await db
      .select()
      .from(workspaceMembershipsTable)
      .where(eq(workspaceMembershipsTable.workspaceId, newId))
    expect(memberships).toHaveLength(1)
    expect(memberships[0].userId).toBe(testUserId)
    expect(memberships[0].role).toBe('admin')
  })

  it('clones models with fresh ids', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()
    await db.insert(modelsTable).values({
      id: 'model-a',
      provider: 'openai',
      name: 'My Model',
      model: 'gpt-x',
      workspaceId: source.id,
    })

    const newId = await duplicateWorkspace(db, source, { creatorUserId: testUserId, name: 'Source Copy' })

    const clones = await db.select().from(modelsTable).where(eq(modelsTable.workspaceId, newId))
    expect(clones).toHaveLength(1)
    expect(clones[0].id).not.toBe('model-a')
    expect(clones[0].name).toBe('My Model')
    expect(clones[0].model).toBe('gpt-x')
  })

  it('remaps prompt.modelId to the cloned model', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()
    await db.insert(modelsTable).values({
      id: 'model-a',
      provider: 'openai',
      name: 'M',
      workspaceId: source.id,
    })
    await db.insert(promptsTable).values({
      id: 'prompt-a',
      title: 'P',
      prompt: 'hi',
      modelId: 'model-a',
      workspaceId: source.id,
    })

    const newId = await duplicateWorkspace(db, source, { creatorUserId: testUserId, name: 'Source Copy' })

    const newModels = await db.select().from(modelsTable).where(eq(modelsTable.workspaceId, newId))
    const newPrompts = await db.select().from(promptsTable).where(eq(promptsTable.workspaceId, newId))
    expect(newPrompts).toHaveLength(1)
    expect(newPrompts[0].modelId).toBe(newModels[0].id)
    expect(newPrompts[0].modelId).not.toBe('model-a')
  })

  it('remaps trigger.promptId to the cloned prompt', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()
    await db.insert(promptsTable).values({
      id: 'prompt-a',
      title: 'P',
      prompt: 'hi',
      workspaceId: source.id,
    })
    await db.insert(triggersTable).values({
      id: 'trigger-a',
      triggerType: 'time',
      triggerTime: '08:00',
      promptId: 'prompt-a',
      workspaceId: source.id,
    })

    const newId = await duplicateWorkspace(db, source, { creatorUserId: testUserId, name: 'Source Copy' })

    const newPrompts = await db.select().from(promptsTable).where(eq(promptsTable.workspaceId, newId))
    const newTriggers = await db.select().from(triggersTable).where(eq(triggersTable.workspaceId, newId))
    expect(newTriggers).toHaveLength(1)
    expect(newTriggers[0].promptId).toBe(newPrompts[0].id)
    expect(newTriggers[0].promptId).not.toBe('prompt-a')
  })

  it('remaps model_profiles to the cloned model (PK doubles as FK)', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()
    await db.insert(modelsTable).values({ id: 'model-a', provider: 'openai', name: 'M', workspaceId: source.id })
    await db.insert(modelProfilesTable).values({ modelId: 'model-a', temperature: 0.7, workspaceId: source.id })

    const newId = await duplicateWorkspace(db, source, { creatorUserId: testUserId, name: 'Source Copy' })

    const newModels = await db.select().from(modelsTable).where(eq(modelsTable.workspaceId, newId))
    const newProfiles = await db.select().from(modelProfilesTable).where(eq(modelProfilesTable.workspaceId, newId))
    expect(newProfiles).toHaveLength(1)
    expect(newProfiles[0].modelId).toBe(newModels[0].id)
    expect(newProfiles[0].temperature).toBe(0.7)
  })

  it('clones skills, modes, mcp_servers, tasks with fresh ids', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()
    await db.insert(skillsTable).values({ id: 'skill-a', name: 'Skill', workspaceId: source.id })
    await db.insert(modesTable).values({ id: 'mode-a', name: 'Mode', workspaceId: source.id })
    await db.insert(mcpServersTable).values({ id: 'mcp-a', name: 'Mcp', workspaceId: source.id })
    await db.insert(tasksTable).values({ id: 'task-a', item: 'Task', userId: testUserId, workspaceId: source.id })

    const newId = await duplicateWorkspace(db, source, { creatorUserId: testUserId, name: 'Source Copy' })

    const counts = await Promise.all(
      [skillsTable, modesTable, mcpServersTable, tasksTable].map(
        async (t) => (await db.select().from(t).where(eq(t.workspaceId, newId))).length,
      ),
    )
    expect(counts).toEqual([1, 1, 1, 1])
  })

  it('does NOT clone chat_threads or chat_messages', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()
    await db
      .insert(chatThreadsTable)
      .values({ id: 'thread-a', title: 'Thread', userId: testUserId, workspaceId: source.id })
    await db.insert(chatMessagesTable).values({
      id: 'msg-a',
      content: 'hi',
      role: 'user',
      chatThreadId: 'thread-a',
      userId: testUserId,
      workspaceId: source.id,
    })

    const newId = await duplicateWorkspace(db, source, { creatorUserId: testUserId, name: 'Source Copy' })

    const newThreads = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.workspaceId, newId))
    const newMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.workspaceId, newId))
    expect(newThreads).toHaveLength(0)
    expect(newMessages).toHaveLength(0)
  })

  it('skips soft-deleted source rows', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()
    await db.insert(skillsTable).values({ id: 'skill-live', name: 'Live', workspaceId: source.id })
    await db
      .insert(skillsTable)
      .values({ id: 'skill-dead', name: 'Dead', deletedAt: new Date().toISOString(), workspaceId: source.id })

    const newId = await duplicateWorkspace(db, source, { creatorUserId: testUserId, name: 'Source Copy' })

    const clones = await db.select().from(skillsTable).where(eq(skillsTable.workspaceId, newId))
    expect(clones).toHaveLength(1)
    expect(clones[0].name).toBe('Live')
  })

  it('persists the supplied slug + icon on the new workspace row', async () => {
    const db = getDb()
    const source = await seedBareSourceWorkspace()

    const newId = await duplicateWorkspace(db, source, {
      creatorUserId: testUserId,
      name: 'Source Copy',
      slug: 'source-copy',
      icon: '🛠️',
    })

    const ws = await db.select().from(workspacesTable).where(eq(workspacesTable.id, newId))
    expect(ws[0].slug).toBe('source-copy')
    expect(ws[0].icon).toBe('🛠️')
  })
})
