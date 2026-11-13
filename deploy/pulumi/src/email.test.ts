/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'
import { createBackendEmail } from './email'

pulumi.runtime.setMocks(
  {
    newResource: ({ name, inputs }) => ({
      id: name,
      state: {
        ...inputs,
        arn: `arn:aws:secretsmanager:test:${name.startsWith('rotation-') ? 'email-secret' : name}`,
        versionId: name.startsWith('rotation-after') ? 'version-two' : 'version-one',
      },
    }),
    call: ({ inputs }) => inputs,
  },
  'email-test',
  'test',
  false,
)

/** Await the resolved resource inputs without provisioning cloud resources. */
const resolve = <T>(value: pulumi.Input<T>): Promise<pulumi.Unwrap<T>> =>
  new Promise((done) => {
    pulumi.output(value).apply((resolved) => {
      done(resolved)
    })
  })

test('email is opt-in and creates no secret or IAM dependencies by default', () => {
  expect(createBackendEmail('disabled', 'exec-role')).toEqual({ environment: [], secrets: [], dependencies: [] })
})

test('sender and recipient can be configured independently without creating an empty secret', () => {
  const sender = createBackendEmail('sender', 'exec-role', { from: 'hello@example.com' })
  expect(sender.environment).toEqual([{ name: 'EMAIL_FROM', value: 'hello@example.com' }])
  expect(sender.secrets).toEqual([])
  expect(sender.dependencies).toEqual([])
  const recipient = createBackendEmail('recipient', 'exec-role', { contactEmailTo: 'team@example.com' })
  expect(recipient.environment).toEqual([{ name: 'CONTACT_EMAIL_TO', value: 'team@example.com' }])
  expect(recipient.secrets).toEqual([])
})

test('configured email injects a secret reference and grants only the execution role access to that secret', async () => {
  const email = createBackendEmail('configured', 'backend-exec-role', {
    from: 'hello@example.com',
    contactEmailTo: 'team@example.com',
    resendApiKey: pulumi.secret('re_test_not_a_real_key'),
  })
  expect(email.environment).toEqual([
    { name: 'EMAIL_FROM', value: 'hello@example.com' },
    { name: 'CONTACT_EMAIL_TO', value: 'team@example.com' },
  ])
  expect(await resolve(email.secrets)).toEqual([
    { name: 'RESEND_API_KEY', valueFrom: 'arn:aws:secretsmanager:test:configured-resend-api-key:::version-one' },
  ])
  const policy = email.dependencies.find((resource) => resource instanceof aws.iam.RolePolicy)!
  const version = email.dependencies.find((resource) => resource instanceof aws.secretsmanager.SecretVersion)!
  expect(await resolve(policy.role)).toBe('backend-exec-role')
  expect(JSON.parse(await resolve(policy.policy))).toEqual({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: ['arn:aws:secretsmanager:test:configured-resend-api-key'],
      },
    ],
  })
  expect(await resolve(version.secretString)).toBe('re_test_not_a_real_key')
  expect(await pulumi.isSecret(version.secretString)).toBe(true)
})

test('rotating the key changes the task secret reference even when its ARN is unchanged', async () => {
  const before = createBackendEmail('rotation-before', 'exec-role', { resendApiKey: pulumi.secret('re_original_test') })
  const after = createBackendEmail('rotation-after', 'exec-role', { resendApiKey: pulumi.secret('re_rotated_test') })
  expect(await resolve(before.secrets)).toEqual([
    { name: 'RESEND_API_KEY', valueFrom: 'arn:aws:secretsmanager:test:email-secret:::version-one' },
  ])
  expect(await resolve(after.secrets)).toEqual([
    { name: 'RESEND_API_KEY', valueFrom: 'arn:aws:secretsmanager:test:email-secret:::version-two' },
  ])
})
