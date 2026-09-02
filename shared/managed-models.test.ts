/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { managedModels } from './managed-models'

describe('managed model catalog', () => {
  it('matches the shipped schema-v1 catalog', () => {
    expect(managedModels).toMatchInlineSnapshot(`
      {
        "defaultModelId": "019af08a-c27b-7074-8aac-95315d1ef3fd",
        "models": [
          {
            "capabilities": {
              "contextWindow": 200000,
              "input": [
                "text",
                "image",
              ],
              "parallelToolCalls": true,
              "reasoning": true,
              "tools": true,
            },
            "defaults": {
              "startWithReasoning": false,
            },
            "description": "Top-tier Anthropic reasoning",
            "id": "019af08a-c27b-7074-8aac-95315d1ef3fd",
            "model": "opus-5",
            "name": "Opus 5",
            "transport": "direct",
            "vendor": "anthropic",
          },
          {
            "capabilities": {
              "contextWindow": 131072,
              "input": [
                "text",
              ],
              "parallelToolCalls": false,
              "reasoning": true,
              "tools": true,
            },
            "defaults": {
              "startWithReasoning": false,
            },
            "description": "Fast DeepSeek reasoning",
            "id": "019f227e-d640-727d-ba12-d51bd7d0a3d6",
            "model": "deepseek-v4-flash",
            "name": "DeepSeek V4 Flash",
            "transport": "direct",
            "vendor": "deepseek",
          },
          {
            "capabilities": {
              "contextWindow": 131072,
              "input": [
                "text",
              ],
              "parallelToolCalls": false,
              "reasoning": true,
              "tools": true,
            },
            "defaults": {
              "startWithReasoning": false,
            },
            "description": "Confidential chat via Thunderbolt",
            "id": "019e7580-2b0e-719c-a43f-d2b56e7f31b4",
            "model": "glm-5-2",
            "name": "GLM 5.2",
            "transport": "confidential",
            "vendor": "zhipu",
          },
        ],
        "schemaVersion": 1,
        "version": 4,
      }
    `)
  })
})
