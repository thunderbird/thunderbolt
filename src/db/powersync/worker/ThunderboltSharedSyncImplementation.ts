import type { SubscribedStream } from '@powersync/common'
import { WebRemote } from 'powersync-web-internal/db/sync/WebRemote.js'
import { WebStreamingSyncImplementation } from 'powersync-web-internal/db/sync/WebStreamingSyncImplementation.js'
import { SharedSyncImplementation } from 'powersync-web-internal/worker/sync/SharedSyncImplementation.js'
import { encryptionMiddleware } from '../middleware/EncryptionMiddleware'
import { TransformableBucketStorage } from '../TransformableBucketStorage'

/**
 * Extends SharedSyncImplementation to inject TransformableBucketStorage with
 * encryption middleware into the SharedWorker's sync pipeline.
 *
 * This enables multi-tab support (enableMultiTabs: true) while still running
 * data transformations before sync data is written to the local database.
 *
 * The parent class hardcodes SqliteBucketStorage in generateStreamingImplementation().
 * We override it to use TransformableBucketStorage with our middleware instead.
 */
export class ThunderboltSharedSyncImplementation extends SharedSyncImplementation {
  protected generateStreamingImplementation() {
    const syncParams = this.syncParams!

    const storage = new TransformableBucketStorage(this.distributedDB!)
    storage.addTransformer(encryptionMiddleware)

    // `subscriptions` is declared private in SharedSyncImplementation — access at runtime.
    const subscriptions = (this as unknown as { subscriptions: SubscribedStream[] }).subscriptions

    return new WebStreamingSyncImplementation({
      adapter: storage,
      remote: new WebRemote(
        {
          invalidateCredentials: async () => {
            const lastPort = await this.getLastWrappedPort()
            if (!lastPort) {
              throw new Error('No client port found to invalidate credentials')
            }
            try {
              this.logger.log('calling the last port client provider to invalidate credentials')
              lastPort.clientProvider.invalidateCredentials()
            } catch (ex) {
              this.logger.error('error invalidating credentials', ex)
            }
          },
          fetchCredentials: async () => {
            const lastPort = await this.getLastWrappedPort()
            if (!lastPort) {
              throw new Error('No client port found to fetch credentials')
            }
            return new Promise(async (resolve, reject) => {
              const abortController = new AbortController()
              this.fetchCredentialsController = {
                controller: abortController,
                activePort: lastPort,
              }
              abortController.signal.onabort = reject
              try {
                this.logger.log('calling the last port client provider for credentials')
                resolve(await lastPort.clientProvider.fetchCredentials())
              } catch (ex) {
                reject(ex)
              } finally {
                this.fetchCredentialsController = undefined
              }
            })
          },
        },
        this.logger,
      ),
      uploadCrud: async () => {
        const lastPort = await this.getLastWrappedPort()
        if (!lastPort) {
          throw new Error('No client port found to upload crud')
        }
        return new Promise(async (resolve, reject) => {
          const abortController = new AbortController()
          this.uploadDataController = {
            controller: abortController,
            activePort: lastPort,
          }
          abortController.signal.onabort = () => resolve()
          try {
            resolve(await lastPort.clientProvider.uploadCrud())
          } catch (ex) {
            reject(ex)
          } finally {
            this.uploadDataController = undefined
          }
        })
      },
      ...syncParams.streamOptions,
      subscriptions,
      logger: this.logger,
    })
  }
}
