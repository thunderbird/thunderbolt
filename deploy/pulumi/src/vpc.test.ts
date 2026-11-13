/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  albIngress,
  cloudflareOnlyStack,
  cloudflareProxiedStack,
  previewCloudflareProxy,
  requireCompleteServiceHostnames,
  requirePreviewCloudflareConfig,
} from './alb-ingress'

describe('ALB ingress', () => {
  it('limits Cloudflare-mode HTTP origins to Cloudflare source ranges', () => {
    const rules = albIngress(true, ['173.245.48.0/20'])
    expect(rules.flatMap((rule) => rule.cidrBlocks ?? [])).not.toContain('0.0.0.0/0')
    expect(rules.every((rule) => rule.fromPort === 80 && rule.toPort === 80)).toBe(true)
    expect(rules[0]?.cidrBlocks).toHaveLength(1)
    expect(rules.flatMap((rule) => rule.cidrBlocks ?? [])).toContain('173.245.48.0/20')
  })

  it('fails closed if the provider returns no Cloudflare ranges', () => {
    expect(() => albIngress(true, [])).toThrow('Cloudflare IPv4 ranges')
  })

  it('keeps raw-ALB stacks publicly reachable', () => {
    expect(albIngress(false, [])).toEqual([
      { protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: ['0.0.0.0/0'] },
      { protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'] },
    ])
  })

  it('uses strict ALB host routing only when every service has its own hostname', () => {
    const names = ['app.example.com', 'api.example.com', 'auth.example.com', 'sync.example.com', 'www.example.com']
    expect(cloudflareOnlyStack('fargate', names)).toBe(true)
    expect(cloudflareOnlyStack('fargate', [...names.slice(0, 4), undefined])).toBe(false)
    expect(cloudflareOnlyStack('fargate', [...names.slice(0, 4), names[0]])).toBe(false)
    expect(cloudflareOnlyStack('fargate', [])).toBe(false)
    expect(cloudflareOnlyStack('k8s', names)).toBe(false)
  })

  it('protects any Fargate stack routed through Cloudflare, including shared hostnames', () => {
    expect(cloudflareProxiedStack('fargate', true)).toBe(true)
    expect(cloudflareProxiedStack('fargate', false)).toBe(false)
    expect(cloudflareProxiedStack('k8s', true)).toBe(false)
  })

  it('rejects partial Cloudflare Fargate hostnames while allowing complete and direct modes', () => {
    const complete = {
      marketing: 'www.example.com',
      app: 'app.example.com',
      api: 'api.example.com',
      auth: 'auth.example.com',
      powersync: 'sync.example.com',
    }
    expect(() => requireCompleteServiceHostnames('fargate', true, { ...complete, powersync: undefined })).toThrow(
      'powersync',
    )
    expect(() => requireCompleteServiceHostnames('fargate', true, { ...complete, marketing: undefined })).toThrow(
      'marketing',
    )
    expect(() => requireCompleteServiceHostnames('fargate', true, complete)).not.toThrow()
    expect(() =>
      requireCompleteServiceHostnames(
        'fargate',
        true,
        Object.fromEntries(Object.keys(complete).map((key) => [key, 'shared.example.com'])),
      ),
    ).not.toThrow()
    expect(() =>
      requireCompleteServiceHostnames(
        'fargate',
        false,
        Object.fromEntries(Object.keys(complete).map((key) => [key, undefined])),
      ),
    ).not.toThrow()
    expect(() => requireCompleteServiceHostnames('k8s', true, { ...complete, powersync: undefined })).not.toThrow()
  })

  it('requires both Cloudflare values for the shared preview origin', () => {
    expect(() => requirePreviewCloudflareConfig(undefined, 'token')).toThrow('cloudflareZoneId')
    expect(() => requirePreviewCloudflareConfig('zone', undefined)).toThrow('cloudflareApiToken')
    expect(() => requirePreviewCloudflareConfig('zone', 'token')).not.toThrow()
  })

  it('couples the shared preview ingress rule to per-PR backend header trust', () => {
    expect(previewCloudflareProxy.restrictIngress).toBe(true)
    expect(previewCloudflareProxy.trustedProxy).toBe('cloudflare')
  })
})
