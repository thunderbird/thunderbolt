/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

export type EmailConfig = {
  from?: string
  contactEmailTo?: string
  resendApiKey?: pulumi.Output<string>
}

/** Configure backend email without putting the sending key in the task definition. */
export const createBackendEmail = (name: string, role: pulumi.Input<string>, config: EmailConfig = {}) => {
  const environment = [
    ...(config.from ? [{ name: 'EMAIL_FROM', value: config.from }] : []),
    ...(config.contactEmailTo ? [{ name: 'CONTACT_EMAIL_TO', value: config.contactEmailTo }] : []),
  ]
  if (!config.resendApiKey) return { environment, secrets: [], dependencies: [] }

  const secret = new aws.secretsmanager.Secret(`${name}-resend-api-key`, {
    tags: { Name: `${name}-resend-api-key` },
  })
  const version = new aws.secretsmanager.SecretVersion(`${name}-resend-api-key-version`, {
    secretId: secret.arn,
    secretString: config.resendApiKey,
  })
  const policy = new aws.iam.RolePolicy(`${name}-exec-email-policy`, {
    role,
    policy: pulumi.jsonStringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: ['secretsmanager:GetSecretValue'], Resource: [secret.arn] }],
    }),
  })
  return {
    environment,
    // Pin the version so rotating the key revises the task definition and rolls out fresh tasks.
    secrets: [{ name: 'RESEND_API_KEY', valueFrom: pulumi.interpolate`${secret.arn}:::${version.versionId}` }],
    dependencies: [policy, version],
  }
}
