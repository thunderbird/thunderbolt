/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Devices
export {
  bridgeDeviceId,
  cliDeviceIdPrefix,
  maxActiveDevicesPerUser,
  withUserDeviceRegistrationLock,
  isCliDeviceId,
  isTrustedAppDevice,
  getDeviceById,
  upsertDevice,
  upsertCliDevice,
  revokeDevice,
  denyDevice,
  markDeviceTrusted,
  registerDevice,
  registerBridgeDevice,
  deleteRevokedBridgeDevice,
  setDeviceNodeId,
  getTrustedNodeIds,
  listEnvelopeCapableDeviceIds,
  listEnvelopeCapableDevices,
  listDevicesAwaitingLockout,
  countActiveDevices,
} from './devices'

// Users
export { getUserById, getUserByEmail, deleteUser, markUserNotNew } from './users'

// Sessions
export { getActivePersistedSession, linkSessionToDevice, revokeDeviceSessions } from './sessions'

// Waitlist
export { getWaitlistByEmail, createWaitlistEntry, approveWaitlistEntry } from './waitlist'

// PowerSync
export { applyOperation } from './powersync'

export {
  createDebugTranscript,
  findDebugTranscriptClientByKeyHash,
  upsertSelfDebugTranscriptClient,
} from './debug-transcripts'

// OTP Challenge (session binding)
export {
  getOrCreateOtpChallenge,
  validateOtpChallenge,
  deleteOtpChallengesForEmail,
  deletePersistedSignInOtp,
} from './otp-challenge'

// Encryption
export {
  getEnvelopeByDeviceId,
  hasEnvelopesForUser,
  upsertEnvelope,
  deleteEnvelope,
  getOrgEnvelope,
  upsertOrgEnvelope,
  getEncryptionMetadata,
  insertEncryptionMetadataIfNotExists,
  replaceEncryptionMetadata,
  flipSchemeToV2,
  bumpKeyVersion,
  setPrimaryKeyId,
  getWrappedKey,
  listWrappedKeys,
  insertWrappedKey,
  updateWrappedKey,
  issueChallengeNonce,
  consumeChallengeNonce,
  deleteExpiredOrConsumedNonces,
} from './encryption'
