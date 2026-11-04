/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

export const cloudModelSchema = z
  .object({
    sourceId: z.string().min(1).optional(),
    provider: z.enum(['managed', 'openai-compatible', 'anthropic']),
    modelId: z.string().min(1),
    baseUrl: z.string().optional(),
    connectionId: z.string().optional(),
    contextWindow: z.number().int().min(1024).max(2000000),
    maxOutputTokens: z.number().int().min(1).max(200000),
    inputCostPerMillion: z.number().positive().optional(),
    outputCostPerMillion: z.number().positive().optional(),
  })
  .refine((model) => model.maxOutputTokens < model.contextWindow, {
    path: ['maxOutputTokens'],
    message: 'Output limit must be below the context window',
  })
  .refine(
    (model) =>
      model.provider === 'managed' ||
      (model.inputCostPerMillion !== undefined && model.outputCostPerMillion !== undefined),
    { path: ['inputCostPerMillion'], message: 'Custom models require positive input and output prices' },
  )
export const resourcePublicKeySchema = z.strictObject({
  version: z.literal(1),
  keyId: z.string().min(1).max(128),
  ecdhPublicKey: z.string().min(1).max(256),
  mlkemPublicKey: z.string().min(1).max(2048),
})
export const cloudAgentConfigSchema = z.object({
  ownerRecipient: resourcePublicKeySchema,
  name: z.string().min(1),
  icon: z.string().max(64).nullable().optional(),
  description: z.string(),
  instructions: z.string(),
  model: cloudModelSchema.nullable(),
  localModelId: z.string().min(1).optional(),
  modelOrder: z.array(z.string().min(1)).max(100).optional(),
  models: z
    .array(
      z.object({
        localModelId: z.string().min(1).optional(),
        name: z.string(),
        model: cloudModelSchema.nullable(),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
  skills: z.array(
    z.object({
      sourceId: z.string().min(1).optional(),
      name: z.string(),
      description: z.string(),
      instruction: z.string(),
    }),
  ),
  connectionIds: z.array(z.string()),
  mcpServers: z
    .array(z.object({ sourceId: z.string().min(1), name: z.string().min(1) }))
    .max(100)
    .optional(),
  searchEnabled: z.boolean(),
  approvalMode: z.enum(['ask', 'full-access']),
  maxSteps: z.number().int().positive().nullable(),
  maxRunCostUsd: z.number().positive().nullable(),
})
export const cloudMessageContentSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  toolError: z.boolean().optional(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()) }))
    .optional(),
  artifactIds: z.array(z.string()).optional(),
})
export const cloudApprovalPayloadSchema = z.object({
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()),
})
export const cloudConnectionConfigSchema = z.object({
  libraryRef: z.object({ kind: z.enum(['mcp', 'model']), id: z.string().min(1) }).optional(),
  modelLimits: z
    .object({
      contextWindow: z.number().int().positive(),
      maxOutputTokens: z.number().int().positive(),
      inputCostPerMillion: z.number().nonnegative(),
      outputCostPerMillion: z.number().nonnegative(),
    })
    .optional(),
  name: z.string().min(1),
  kind: z.enum(['mcp', 'model']),
  url: z.string(),
  authentication: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('bearer'), token: z.string() }),
    z.object({
      type: z.literal('oauth'),
      accessToken: z.string(),
      refreshToken: z.string().optional(),
      expiresAt: z.string().optional(),
      issuer: z.string(),
      tokenEndpoint: z.string(),
      clientId: z.string(),
      resource: z.string(),
    }),
  ]),
  allowedTools: z.array(z.string()).optional(),
})
export const cloudScheduleConfigSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  timezone: z.string(),
  cadence: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('daily'),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    }),
    z.object({ type: z.literal('interval'), minutes: z.number().int().positive() }),
  ]),
  conversationId: z.string().optional(),
})
export const artifactManifestSchema = z.object({
  title: z.string(),
  mediaType: z.string(),
  files: z.array(z.object({ path: z.string(), mediaType: z.string(), size: z.number().nonnegative() })),
})
export const artifactSnapshotSchema = z.object({
  files: z.array(z.object({ path: z.string(), mediaType: z.string(), content: z.string() })),
})

/** Approval policy is bound to the encrypted user command, including offline retries. */
export const cloudSubmissionSchema = z.object({
  text: z.string().min(1).max(200_000),
  approvalMode: z.enum(['ask', 'full-access']).optional(),
})
