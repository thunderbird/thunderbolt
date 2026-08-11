/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export { encryptedColumnsMap, isEncryptionEnabled, needsSyncSetupWizard } from './config'
export {
  codec,
  invalidateKeyCache,
  resetCodecState,
  keysSyncChannelName,
  type EncryptionCodec,
  type EncryptionContext,
  type KeysSyncMessage,
  type KeysSyncChannel,
  type KeyRequestReason,
} from './codec'
export {
  createKeyRequestResponder,
  startKeyRequestResponder,
  type KeyRequestResponder,
  type KeyRequestResponderDeps,
} from './key-request-responder'
export { encodeForUpload } from './upload-encoder'
export {
  encPrefix,
  encV2Prefix,
  isEncryptedValue,
  isV2EncryptedValue,
  parseWireValue,
  formatWireValue,
  type ParsedWireValue,
} from './wire-format'
