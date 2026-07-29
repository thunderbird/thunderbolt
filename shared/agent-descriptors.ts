/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Wire contract for the descriptor-driven agent creation flow (THU-743).
 *
 * A **descriptor** is "an agent creation form as data": the backend curates it,
 * the frontend renders it over a closed widget registry, and the backend rebuilds
 * a zod validator from the same descriptor to re-validate the submitted spec (the
 * client is never trusted). Both ends import this file — drift here is silent
 * breakage, so the shapes and the validator live in one place.
 *
 * Descriptors are deliberately NOT JSON Schema: the model is steps → fields →
 * widgets, with `visibleWhen` conditional fields and `source`-backed options. A
 * spec is the flat map of field key → value the user fills in.
 */

import { z } from 'zod'

/** Returned to the client (409) when a deploy carries a stale `schemaVersion`. */
export const schemaVersionMismatch = 'SCHEMA_VERSION_MISMATCH'

/** A single spec value: a scalar (`text`/`select`/…) or a list (`gallery`/multi). */
export const specValueSchema = z.union([z.string(), z.array(z.string())])
export type SpecValue = z.infer<typeof specValueSchema>

/** A deploy spec: the flat map of field key → value collected from the form. */
export const agentSpecSchema = z.record(z.string(), specValueSchema)
export type AgentSpec = z.infer<typeof agentSpecSchema>

/** The closed set of widgets the frontend renderer knows how to draw. */
export const widgetSchema = z.enum(['text', 'password', 'textarea', 'select', 'option-cards', 'gallery', 'file-upload'])
export type Widget = z.infer<typeof widgetSchema>

/** One selectable option for `select` / `option-cards` / `gallery` widgets. */
export const optionSchema = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  icon: z.string().nullable().optional(),
})
export type AgentFieldOption = z.infer<typeof optionSchema>

/**
 * Where a field's options come from. `inline` ships them in the descriptor;
 * `fetched` names a `sourceId` the frontend resolves at
 * `GET /agents/:descriptorId/sources/:sourceId` (e.g. live Deepset indexes).
 */
export const optionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), options: z.array(optionSchema) }),
  z.object({ kind: z.literal('fetched'), sourceId: z.string() }),
])
export type OptionSource = z.infer<typeof optionSourceSchema>

/** Conditional visibility: show this field only when `field` currently equals `equals`. */
export const visibleWhenSchema = z.object({
  field: z.string(),
  equals: z.string(),
})
export type VisibleWhen = z.infer<typeof visibleWhenSchema>

/** A single form field bound to one spec key. */
export const fieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  widget: widgetSchema,
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
  default: specValueSchema.optional(),
  visibleWhen: visibleWhenSchema.optional(),
  source: optionSourceSchema.optional(),
  /** Whether the field collects multiple values (always true for `gallery`). */
  multiple: z.boolean().optional(),
  maxLength: z.number().int().positive().optional(),
})
export type AgentField = z.infer<typeof fieldSchema>

/** A group of fields shown together. A single-field/single-option step may be skipped in the UI. */
export const stepSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  fields: z.array(fieldSchema),
})
export type AgentStep = z.infer<typeof stepSchema>

/** What submitting the descriptor does. Phase 1 ships `deploy`; `connect` is the
 *  future home for the URL-based custom-agent flow. */
export const agentActionSchema = z.enum(['deploy', 'connect'])
export type AgentAction = z.infer<typeof agentActionSchema>

/**
 * A curated agent creation form. `id` is the unique catalog entry; `provider` is
 * the registry key (the "kind": haystack/openclaw/…) the backend dispatches the
 * deploy to. `schemaVersion` guards against a client submitting against a stale
 * descriptor.
 */
export const agentDescriptorSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  schemaVersion: z.number().int().nonnegative(),
  action: agentActionSchema,
  steps: z.array(stepSchema),
})
export type AgentDescriptor = z.infer<typeof agentDescriptorSchema>

/** Envelope for `GET /agents/catalog`. */
export const agentCatalogResponseSchema = z.object({
  version: z.literal('1'),
  descriptors: z.array(agentDescriptorSchema),
})
export type AgentCatalogResponse = z.infer<typeof agentCatalogResponseSchema>

/**
 * Normalized deploy lifecycle state (host statuses map onto these). `pending` is
 * spinning up; `running` is usable (a deployed pipeline, including one Deepset
 * has auto-idled — it wakes on query); `failed` is a failed deploy; `gone` is
 * deleted or undeployed on the host (unusable — redeploy or remove it).
 */
export const deployStatusSchema = z.enum(['pending', 'running', 'failed', 'gone'])
export type DeployStatus = z.infer<typeof deployStatusSchema>

/** How the frontend connects to a deployed agent once it is running. */
export const agentConnectionSchema = z.object({
  url: z.string(),
  transport: z.literal('websocket'),
})
export type AgentConnection = z.infer<typeof agentConnectionSchema>

/** Body of `POST /agents/deploy`. */
export const deployRequestSchema = z.object({
  descriptorId: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  spec: agentSpecSchema,
})
export type DeployRequest = z.infer<typeof deployRequestSchema>

/** Response of `POST /agents/deploy`. `deploymentId` encodes `provider:ref`.
 *  `connection` is the (deterministic) chat endpoint, returned up front so the
 *  client can persist the agent immediately without polling. Null when a provider
 *  can't resolve it at deploy time. */
export const deployResponseSchema = z.object({
  deploymentId: z.string(),
  status: deployStatusSchema,
  connection: agentConnectionSchema.nullable(),
})
export type DeployResponse = z.infer<typeof deployResponseSchema>

/** Response of `GET /agents/deployments/:id` — status polled live from the host. */
export const deploymentStatusResponseSchema = z.object({
  deploymentId: z.string(),
  status: deployStatusSchema,
  detail: z.string().nullable().optional(),
  connection: agentConnectionSchema.nullable().optional(),
})
export type DeploymentStatusResponse = z.infer<typeof deploymentStatusResponseSchema>

/** True when a spec value carries a usable (non-empty) value. */
const hasValue = (value: SpecValue | undefined): boolean =>
  Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim().length > 0

/** Whether a field collects a list rather than a scalar. */
const isMultiValue = (field: AgentField): boolean => field.multiple === true || field.widget === 'gallery'

/** Every field across every step, flattened in order. */
export const allFields = (descriptor: AgentDescriptor): AgentField[] => descriptor.steps.flatMap((step) => step.fields)

/** A field is visible when it has no `visibleWhen`, or the guarded field's current
 *  value equals the guard. */
export const isFieldVisible = (field: AgentField, spec: AgentSpec): boolean => {
  if (!field.visibleWhen) {
    return true
  }
  return spec[field.visibleWhen.field] === field.visibleWhen.equals
}

/** The fields currently visible given `spec`. */
export const visibleFields = (descriptor: AgentDescriptor, spec: AgentSpec): AgentField[] =>
  allFields(descriptor).filter((field) => isFieldVisible(field, spec))

/**
 * Build the initial spec from field defaults. Visibility is evaluated against the
 * full set of defaults, then hidden fields are dropped so we never seed a value
 * the user can't see (which the backend re-validation would reject).
 */
export const defaultSpec = (descriptor: AgentDescriptor): AgentSpec => {
  const withAllDefaults: AgentSpec = {}
  for (const field of allFields(descriptor)) {
    if (field.default !== undefined) {
      withAllDefaults[field.key] = field.default
    }
  }
  const result: AgentSpec = {}
  for (const field of allFields(descriptor)) {
    if (field.default !== undefined && isFieldVisible(field, withAllDefaults)) {
      result[field.key] = field.default
    }
  }
  return result
}

/**
 * True when the descriptor's default spec already satisfies every visible required
 * field — i.e. it can be deployed in one click with no user input.
 */
export const isOneClickEligible = (descriptor: AgentDescriptor): boolean => {
  const spec = defaultSpec(descriptor)
  return visibleFields(descriptor, spec)
    .filter((field) => field.required)
    .every((field) => hasValue(spec[field.key]))
}

/**
 * Rebuild a zod validator from a descriptor to re-validate a submitted spec. The
 * frontend uses it via `zodResolver`; the backend re-runs it as the authority.
 * Unknown keys are stripped, values are shaped per widget (scalar vs list), and
 * `required` is enforced only for fields that are visible under the given values.
 */
export const specSchemaForDescriptor = (descriptor: AgentDescriptor) => {
  const fields = allFields(descriptor)
  const shape: Record<string, z.ZodType> = {}
  for (const field of fields) {
    const scalar = field.maxLength ? z.string().max(field.maxLength) : z.string()
    const value = isMultiValue(field) ? z.array(z.string()) : scalar
    shape[field.key] = value.optional()
  }
  return z.object(shape).superRefine((spec, ctx) => {
    const typed = spec as AgentSpec
    for (const field of fields) {
      if (!field.required || !isFieldVisible(field, typed)) {
        continue
      }
      if (!hasValue(typed[field.key])) {
        ctx.addIssue({
          code: 'custom',
          path: [field.key],
          message: `${field.label} is required`,
        })
      }
    }
  })
}
