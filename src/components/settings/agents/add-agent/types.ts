/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type AgentResourceKind = 'model' | 'mcp' | 'skill'
export type AgentEnvironment = 'sandbox' | 'desktop' | 'cloud'
export type AgentResource = {
  id: string
  kind: AgentResourceKind
  scope: 'personal' | 'organization'
  name: string
  description: string
  disabled?: boolean
  defaultSelected?: boolean
}

export type AgentDraft = {
  name: string
  description: string
  systemPrompt: string
  environment: AgentEnvironment
  access: 'approval' | 'full'
  modelOrder?: string[]
  selections: Record<string, boolean>
}
