/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

export type ArtifactObjectStore = {
  put: (key: string, bytes: Uint8Array) => Promise<void>
  get: (key: string) => Promise<Uint8Array>
  remove: (key: string) => Promise<void>
}

/** Store only already encrypted snapshots; credentials stay in the server environment. */
export const createS3ArtifactObjectStore = (options: S3ClientConfig & { bucket: string }): ArtifactObjectStore => {
  const { bucket, ...config } = options
  const client = new S3Client(config)
  return {
    put: async (key, bytes) => {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(60_000) },
      )
    },
    get: async (key) => {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(60_000),
      })
      if (!result.Body) {
        throw new Error('Artifact snapshot is missing its body')
      }
      return result.Body.transformToByteArray()
    },
    remove: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(60_000),
      })
    },
  }
}
