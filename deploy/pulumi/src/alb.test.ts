/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import * as pulumi from '@pulumi/pulumi'
import { createAlb } from './alb'

type Rule = {
  listenerArn: string
  priority: number
  conditions: { hostHeader?: { values: string[] }; pathPattern?: { values: string[] } }[]
  actions: { targetGroupArn: string }[]
}
type Capture = { rules: Rule[]; expected: number; complete: () => void }
const captures = new Map<string, Capture>()
pulumi.runtime.setMocks(
  {
    newResource: ({ type, name, inputs }) => {
      if (type === 'aws:lb/listenerRule:ListenerRule') {
        const rule = inputs as Rule
        const capture = captures.get(rule.listenerArn)!
        capture.rules.push(rule)
        if (capture.rules.length === capture.expected) capture.complete()
      }
      return { id: name, state: { ...inputs, arn: name } }
    },
    call: ({ inputs }) => inputs,
  },
  'routing-test',
  'test',
  false,
)

/** Capture fully resolved listener rules without provisioning AWS resources. */
const captureRules = async (
  name: string,
  hostnames: Parameters<typeof createAlb>[0]['hostnames'],
  expected: number,
) => {
  const rules: Rule[] = []
  const registered = new Promise<void>((complete) => {
    captures.set(`${name}-listener`, { rules, expected, complete })
  })
  createAlb({
    name,
    vpcId: 'vpc-test',
    publicSubnetIds: ['subnet-test'],
    albSgId: 'sg-test',
    hostnames,
  })
  await registered
  expect(new Set(rules.map((rule) => rule.priority)).size).toBe(rules.length)
  return rules
}

/** Evaluate the relevant ALB host/path conditions in AWS priority order. */
const route = (rules: Rule[], host: string, path: string) =>
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

const serviceHosts = {
  marketing: 'www.example.com',
  app: 'app.example.com',
  api: 'api.example.com',
  auth: 'auth.example.com',
  powersync: 'sync.example.com',
}

test('contact reaches the backend while distinct service hosts retain their routing', async () => {
  const rules = await captureRules('distinct', serviceHosts, 9)
  expect(route(rules, serviceHosts.marketing, '/v1/contact')).toBe('distinct-backend-tg')
  for (const path of ['/', '/blog/', '/docs/', '/v1/contact/', '/v1/other']) {
    expect(route(rules, serviceHosts.marketing, path)).toBe('distinct-marketing-tg')
  }
  for (const [host, target] of [
    [serviceHosts.app, 'frontend'],
    [serviceHosts.api, 'backend'],
    [serviceHosts.auth, 'keycloak'],
    [serviceHosts.powersync, 'powersync'],
  ]) {
    for (const path of ['/', '/v1/contact']) {
      expect(route(rules, host, path)).toBe(`distinct-${target}-tg`)
    }
  }
})

test('legacy shared hostnames keep marketing precedence with only the exact contact exception', async () => {
  const sharedHost = 'shared.example.com'
  const hostnames = Object.fromEntries(Object.keys(serviceHosts).map((service) => [service, sharedHost]))
  const rules = await captureRules('legacy', hostnames, 9)
  expect(route(rules, sharedHost, '/v1/contact')).toBe('legacy-backend-tg')
  for (const path of ['/', '/blog/', '/docs/', '/v1/contact/', '/v1/other', '/auth/', '/powersync/']) {
    expect(route(rules, sharedHost, path)).toBe('legacy-marketing-tg')
  }
})

test('deployments without service hostnames retain path-based fallback routing', async () => {
  const rules = await captureRules('fallback', undefined, 3)
  expect(route(rules, 'example.com', '/v1/contact')).toBe('fallback-backend-tg')
  expect(route(rules, 'example.com', '/auth/')).toBe('fallback-keycloak-tg')
  expect(route(rules, 'example.com', '/realms/')).toBe('fallback-keycloak-tg')
  expect(route(rules, 'example.com', '/powersync/')).toBe('fallback-powersync-tg')
  expect(route(rules, 'example.com', '/')).toBeUndefined()
})
