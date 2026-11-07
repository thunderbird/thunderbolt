/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import * as pulumi from '@pulumi/pulumi'
import { createAlb } from './alb'

type Rule = {
  priority: number
  conditions: { hostHeader?: { values: string[] }; pathPattern?: { values: string[] } }[]
  actions: { targetGroupArn: string }[]
}
const rules: Rule[] = []
let complete: () => void
const registered = new Promise<void>((resolve) => {
  complete = resolve
})
pulumi.runtime.setMocks(
  {
    newResource: ({ type, name, inputs }) => {
      if (type === 'aws:lb/listenerRule:ListenerRule') {
        rules.push(inputs as Rule)
        if (rules.length === 6) complete()
      }
      return { id: name, state: { ...inputs, arn: name } }
    },
    call: ({ inputs }) => inputs,
  },
  'routing-test',
  'test',
  false,
)

/** Evaluate the relevant ALB host/path conditions in AWS priority order. */
const route = (host: string, path: string) =>
  [...rules]
    .sort((a, b) => a.priority - b.priority)
    .find((rule) =>
      rule.conditions.every(
        (condition) =>
          (!condition.hostHeader || condition.hostHeader.values.includes(host)) &&
          (!condition.pathPattern ||
            condition.pathPattern.values.some((pattern) =>
              pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
            )),
      ),
    )?.actions[0].targetGroupArn

test('contact reaches the backend while marketing pages and other hosts retain their routing', async () => {
  createAlb({
    name: 'test',
    vpcId: 'vpc-test',
    publicSubnetIds: ['subnet-test'],
    albSgId: 'sg-test',
    hostnames: { marketing: 'www.example.com', api: 'api.example.com' },
  })
  await registered
  expect(new Set(rules.map((rule) => rule.priority)).size).toBe(rules.length)
  expect(route('www.example.com', '/v1/contact')).toBe('test-backend-tg')
  expect(route('www.example.com', '/v1/contact/')).toBe('test-marketing-tg')
  expect(route('www.example.com', '/v1/other')).toBe('test-marketing-tg')
  expect(route('www.example.com', '/blog/')).toBe('test-marketing-tg')
  expect(route('api.example.com', '/v1/contact')).toBe('test-backend-tg')
  expect(route('api.example.com', '/other')).toBe('test-backend-tg')
  expect(route('unconfigured.example.com', '/v1/contact')).toBe('test-backend-tg')
})
