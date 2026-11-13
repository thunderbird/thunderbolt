/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CommonCrypto
import CryptoKit
import Foundation
import Security

enum CryptoFailure: Error, LocalizedError, Equatable {
    case malformedValue
    case invalidKey
    case keyConfigurationIncomplete
    case bridge(String)
    case derivationFailed

    var errorDescription: String? {
        switch self {
        case .malformedValue: return "Encrypted value is malformed."
        case .invalidKey: return "The encryption key is invalid."
        case .keyConfigurationIncomplete: return "Encryption key setup is incomplete."
        case .bridge(let detail): return detail
        case .derivationFailed: return "Unable to derive encryption keys."
        }
    }
}

struct ThunderboltDeviceKeys: Codable, Sendable, Equatable {
    let ecdhPrivateKeyRaw: Data
    let mlkemSecretKey: Data
    let mlkemPublicKey: Data

    var ecdhPrivateKey: P256.KeyAgreement.PrivateKey {
        get throws { try P256.KeyAgreement.PrivateKey(rawRepresentation: ecdhPrivateKeyRaw) }
    }

    var ecdhPublicKeyRaw: Data {
        get throws { try ecdhPrivateKey.publicKey.x963Representation }
    }

    var ecdhPublicKeyBase64: String { get throws { try ecdhPublicKeyRaw.base64EncodedString() } }
    var mlkemPublicKeyBase64: String { mlkemPublicKey.base64EncodedString() }
}

struct OpenedAccountKey: Sendable, Equatable {
    let rawKey: Data
    let primaryKeyID: String
    let keyVersion: UInt32?
}

struct HybridEnvelopeTestEntropy: Sendable {
    let ephemeralECDHPrivateKeyRaw: Data
    let mlkemRandomness: Data
    let iv: Data
}

struct CanaryMaterial: Sendable, Equatable {
    let iv: String
    let ciphertext: String
    let signingPublicKey: String
    let seed: Data
    fileprivate let signingPrivateScalar: Data

    func signChallenge(nonce: String, operation: String, deviceID: String) throws -> String {
        try ThunderboltCrypto.sign(payload: Self.joined(nonce, operation, deviceID), privateScalar: signingPrivateScalar)
    }

    fileprivate static func joined(_ fields: String...) -> Data {
        Data(fields.joined(separator: "\u{001f}").utf8)
    }
}

struct RecoveryMaterial: Sendable, Equatable {
    let phrase: String
    let kdfSalt: String
    let keys: ThunderboltDeviceKeys
}

struct FirstDeviceBootstrap: Sendable {
    let request: DeviceBootstrapRequest
    let accountKey: Data
    let initialDataKey: Data
    let recoveryPhrase: String
    let keys: ThunderboltDeviceKeys
}

enum ThunderboltCrypto {
    static func randomBytes(count: Int) throws -> Data {
        guard count >= 0 else { throw CryptoFailure.derivationFailed }
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { rawBuffer in
            SecRandomCopyBytes(kSecRandomDefault, count, rawBuffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw CryptoFailure.derivationFailed }
        return data
    }

    static func generateDeviceKeys() throws -> ThunderboltDeviceKeys {
        let ecdh = P256.KeyAgreement.PrivateKey()
        let seed = try randomBytes(count: 64).base64EncodedString()
        let result = try jsonObject(NobleCryptoBridge.shared.invoke("keygen", [seed]))
        guard let publicKey = decodeBase64(result["publicKey"]),
              let secretKey = decodeBase64(result["secretKey"]) else { throw CryptoFailure.bridge("Invalid ML-KEM keypair") }
        return ThunderboltDeviceKeys(ecdhPrivateKeyRaw: ecdh.rawRepresentation, mlkemSecretKey: secretKey, mlkemPublicKey: publicKey)
    }

    static func generateAccountKey() throws -> Data { try randomBytes(count: 32) }

    static func generateKDFSalt() throws -> String { try randomBytes(count: 32).base64EncodedString() }

    static func generateRecoveryMaterial() throws -> RecoveryMaterial {
        let seed = try randomBytes(count: 32)
        let phrase = try NobleCryptoBridge.shared.invoke("mnemonicEncode", [seed.base64EncodedString()])
        let salt = try generateKDFSalt()
        let seedBytes = try decodeRecoveryPhrase(phrase)
        let master = try pbkdf2(seed: seedBytes, salt: Data(base64Encoded: salt)!)
        let ecdhSubseed = hkdf(input: master, info: Data("thunderbolt-recovery-ecdh-v1".utf8), count: 48)
        let scalar = try nobleScalar(ecdhSubseed)
        let mlkemSubseed = hkdf(input: master, info: Data("thunderbolt-recovery-mlkem-v1".utf8), count: 64)
        let kem = try jsonObject(NobleCryptoBridge.shared.invoke("keygen", [mlkemSubseed.base64EncodedString()]))
        guard let publicKey = decodeBase64(kem["publicKey"]), let secretKey = decodeBase64(kem["secretKey"]) else {
            throw CryptoFailure.bridge("Invalid recovery ML-KEM keypair")
        }
        let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar)
        let keys = ThunderboltDeviceKeys(ecdhPrivateKeyRaw: privateKey.rawRepresentation, mlkemSecretKey: secretKey, mlkemPublicKey: publicKey)
        return RecoveryMaterial(phrase: phrase, kdfSalt: salt, keys: keys)
    }

    static func deriveRecoveryMaterial(phrase: String, kdfSalt: String) throws -> ThunderboltDeviceKeys {
        let seed = try decodeRecoveryPhrase(phrase)
        guard let salt = Data(base64Encoded: kdfSalt), salt.count == 32 else { throw CryptoFailure.malformedValue }
        let master = try pbkdf2(seed: seed, salt: salt)
        let scalar = try nobleScalar(hkdf(input: master, info: Data("thunderbolt-recovery-ecdh-v1".utf8), count: 48))
        let mlkemSeed = hkdf(input: master, info: Data("thunderbolt-recovery-mlkem-v1".utf8), count: 64)
        let pair = try jsonObject(NobleCryptoBridge.shared.invoke("keygen", [mlkemSeed.base64EncodedString()]))
        guard let publicKey = decodeBase64(pair["publicKey"]), let secretKey = decodeBase64(pair["secretKey"]) else {
            throw CryptoFailure.bridge("Invalid recovery ML-KEM keypair")
        }
        let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar)
        return ThunderboltDeviceKeys(ecdhPrivateKeyRaw: privateKey.rawRepresentation, mlkemSecretKey: secretKey, mlkemPublicKey: publicKey)
    }

    static func wrapDEK(_ dataKey: Data, accountKey: Data, keyID: String, iv: Data? = nil) throws -> String {
        guard dataKey.count == 32, accountKey.count == 32, isWireKeyID(keyID) else { throw CryptoFailure.invalidKey }
        let iv = try iv ?? randomBytes(count: 12)
        guard iv.count == 12 else { throw CryptoFailure.invalidKey }
        let aad = Data("__kw\u{001f}\(keyID)".utf8)
        let box = try AES.GCM.seal(dataKey, using: SymmetricKey(data: accountKey), nonce: AES.GCM.Nonce(data: iv), authenticating: aad)
        return (iv + box.ciphertext + box.tag).base64EncodedString()
    }

    static func unwrapDEK(_ wrapped: String, accountKey: Data, keyID: String) throws -> Data {
        guard accountKey.count == 32, isWireKeyID(keyID), let blob = Data(base64Encoded: wrapped), blob.count >= 28 else {
            throw CryptoFailure.malformedValue
        }
        let iv = blob.prefix(12)
        let tag = blob.suffix(16)
        let ciphertext = blob.dropFirst(12).dropLast(16)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: Data(ciphertext), tag: Data(tag))
        let aad = Data("__kw\u{001f}\(keyID)".utf8)
        return try AES.GCM.open(box, using: SymmetricKey(data: accountKey), authenticating: aad)
    }

    static func wrapAK(_ accountKey: Data, recipient: ThunderboltDeviceKeys, primaryKeyID: String, keyVersion: UInt32) throws -> String {
        try wrapAK(accountKey, recipientEcdhPublicKey: recipient.ecdhPublicKeyRaw, recipientMLKEMPublicKey: recipient.mlkemPublicKey, primaryKeyID: primaryKeyID, keyVersion: keyVersion)
    }

    static func wrapAK(_ accountKey: Data, recipientEcdhPublicKey: Data, recipientMLKEMPublicKey: Data, primaryKeyID: String, keyVersion: UInt32) throws -> String {
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let entropy = HybridEnvelopeTestEntropy(
            ephemeralECDHPrivateKeyRaw: ephemeral.rawRepresentation,
            mlkemRandomness: try randomBytes(count: 32),
            iv: try randomBytes(count: 12)
        )
        return try wrapAK(accountKey, recipientEcdhPublicKey: recipientEcdhPublicKey, recipientMLKEMPublicKey: recipientMLKEMPublicKey, primaryKeyID: primaryKeyID, keyVersion: keyVersion, entropy: entropy)
    }

    static func wrapAK(_ accountKey: Data, recipientEcdhPublicKey: Data, recipientMLKEMPublicKey: Data, primaryKeyID: String, keyVersion: UInt32, entropy: HybridEnvelopeTestEntropy) throws -> String {
        guard accountKey.count == 32, isMintableKeyID(primaryKeyID), keyVersion > 0, recipientEcdhPublicKey.count == 65 else { throw CryptoFailure.invalidKey }
        guard entropy.mlkemRandomness.count == 32, entropy.iv.count == 12 else { throw CryptoFailure.invalidKey }
        let ephemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: entropy.ephemeralECDHPrivateKeyRaw)
        let publicRaw = ephemeral.publicKey.x963Representation
        let recipient = try P256.KeyAgreement.PublicKey(x963Representation: recipientEcdhPublicKey)
        let sharedEcdh = try ephemeral.sharedSecretFromKeyAgreement(with: recipient).withUnsafeBytes { Data($0) }
        let randomness = entropy.mlkemRandomness.base64EncodedString()
        let encapsulation = try jsonObject(NobleCryptoBridge.shared.invoke("encapsulate", [recipientMLKEMPublicKey.base64EncodedString(), randomness]))
        guard let ciphertext = decodeBase64(encapsulation["ciphertext"]), let sharedMLKEM = decodeBase64(encapsulation["sharedSecret"]) else {
            throw CryptoFailure.bridge("Invalid ML-KEM encapsulation")
        }
        let version: UInt8 = 3
        let key = hybridSealKey(sharedEcdh: sharedEcdh, sharedMLKEM: sharedMLKEM, ecdhTranscript: publicRaw, mlkemTranscript: ciphertext)
        let iv = entropy.iv
        var payload = accountKey
        withUnsafeBytes(of: keyVersion.bigEndian) { payload.append(contentsOf: $0) }
        payload.append(Data(primaryKeyID.utf8))
        let box = try AES.GCM.seal(payload, using: key, nonce: AES.GCM.Nonce(data: iv), authenticating: Data([version]))
        return (Data([version]) + publicRaw + ciphertext + iv + box.ciphertext + box.tag).base64EncodedString()
    }

    static func unwrapAK(_ wrapped: String, deviceKeys: ThunderboltDeviceKeys) throws -> OpenedAccountKey {
        guard let envelope = Data(base64Encoded: wrapped), envelope.count >= 1 + 65 + 1088 + 12 + 32 + 1 + 16 else { throw CryptoFailure.malformedValue }
        let version = envelope[0]
        guard version == 2 || version == 3 else { throw CryptoFailure.malformedValue }
        let eph = Data(envelope[1..<66])
        let kemCiphertext = Data(envelope[66..<1154])
        let iv = Data(envelope[1154..<1166])
        let sealed = Data(envelope[1166...])
        let ephKey = try P256.KeyAgreement.PublicKey(x963Representation: eph)
        let sharedEcdh = try deviceKeys.ecdhPrivateKey.sharedSecretFromKeyAgreement(with: ephKey).withUnsafeBytes { Data($0) }
        let sharedMLKEM = try Data(base64Encoded: NobleCryptoBridge.shared.invoke("decapsulate", [kemCiphertext.base64EncodedString(), deviceKeys.mlkemSecretKey.base64EncodedString()])) ?? { throw CryptoFailure.malformedValue }()
        let key = hybridSealKey(sharedEcdh: sharedEcdh, sharedMLKEM: sharedMLKEM, ecdhTranscript: eph, mlkemTranscript: kemCiphertext)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: Data(sealed.dropLast(16)), tag: Data(sealed.suffix(16)))
        let payload = try AES.GCM.open(box, using: key, authenticating: Data([version]))
        let versionBytes = version == 3 ? 4 : 0
        guard payload.count > 32 + versionBytes else { throw CryptoFailure.malformedValue }
        let keyVersion: UInt32? = version == 3 ? payload[32..<36].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) } : nil
        let pointerData = payload.dropFirst(32 + versionBytes)
        guard let primaryID = String(data: pointerData, encoding: .utf8), isMintableKeyID(primaryID) else { throw CryptoFailure.malformedValue }
        return OpenedAccountKey(rawKey: Data(payload.prefix(32)), primaryKeyID: primaryID, keyVersion: keyVersion)
    }

    static func openBindNonce(_ sealed: DeviceSealedBindNonce, deviceKeys: ThunderboltDeviceKeys) throws -> String {
        guard let ephemeralRaw = Data(base64Encoded: sealed.ephemeralPublicKey), let iv = Data(base64Encoded: sealed.iv), let ciphertext = Data(base64Encoded: sealed.ciphertext) else { throw CryptoFailure.malformedValue }
        let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: ephemeralRaw)
        let shared = try deviceKeys.ecdhPrivateKey.sharedSecretFromKeyAgreement(with: ephemeral).withUnsafeBytes { Data($0) }
        let key = hkdf(input: shared, salt: ephemeralRaw, info: Data("thunderbolt-device-bind-v1".utf8), count: 32)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: Data(ciphertext.dropLast(16)), tag: Data(ciphertext.suffix(16)))
        let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: key))
        guard let nonce = String(data: plaintext, encoding: .utf8) else { throw CryptoFailure.malformedValue }
        return nonce
    }

    static func mintCanary(accountKey: Data, userID: String) throws -> CanaryMaterial {
        guard accountKey.count == 32 else { throw CryptoFailure.invalidKey }
        let seed = try randomBytes(count: 32)
        let iv = try randomBytes(count: 12)
        let aad = Data("__meta\u{001f}canary\u{001f}\(userID)\u{001f}__ak".utf8)
        let box = try AES.GCM.seal(seed, using: SymmetricKey(data: accountKey), nonce: AES.GCM.Nonce(data: iv), authenticating: aad)
        let signingScalar = try nobleScalar(hkdf(input: seed, info: Data("thunderbolt-signing-v1".utf8), count: 48))
        let signingKey = try P256.Signing.PrivateKey(rawRepresentation: signingScalar)
        return CanaryMaterial(iv: iv.base64EncodedString(), ciphertext: (box.ciphertext + box.tag).base64EncodedString(), signingPublicKey: signingKey.publicKey.derRepresentation.base64EncodedString(), seed: seed, signingPrivateScalar: signingScalar)
    }

    static func signChallenge(canary: CanaryMaterial, nonce: String, operation: String, deviceID: String) throws -> String {
        try canary.signChallenge(nonce: nonce, operation: operation, deviceID: deviceID)
    }

    static func signChallenge(canarySeed: Data, nonce: String, operation: String, deviceID: String) throws -> String {
        let payload = Data([nonce, operation, deviceID].joined(separator: "\u{001f}").utf8)
        return try sign(payload: payload, privateScalar: signingScalar(canarySeed: canarySeed))
    }

    static func signingPublicKey(canarySeed: Data) throws -> String {
        let key = try P256.Signing.PrivateKey(rawRepresentation: signingScalar(canarySeed: canarySeed))
        return key.publicKey.derRepresentation.base64EncodedString()
    }

    static func signDeviceAttestation(canarySeed: Data, userID: String, deviceID: String, ecdhPublicKey: String, mlkemPublicKey: String) throws -> String {
        try sign(payload: attestation("thunderbolt-device-attestation-v1", userID, deviceID, ecdhPublicKey, mlkemPublicKey), privateScalar: signingScalar(canarySeed: canarySeed))
    }

    static func verifyDeviceAttestation(canarySeed: Data, signature: String, userID: String, deviceID: String, ecdhPublicKey: String, mlkemPublicKey: String) throws -> Bool {
        try verify(
            signature: signature,
            payload: attestation("thunderbolt-device-attestation-v1", userID, deviceID, ecdhPublicKey, mlkemPublicKey),
            canarySeed: canarySeed
        )
    }

    static func createBootstrap(userID: String, deviceID: String, deviceKeys: ThunderboltDeviceKeys) throws -> FirstDeviceBootstrap {
        let accountKey = try generateAccountKey()
        let dataKey = try randomBytes(count: 32)
        let wrappedDataKey = try wrapDEK(dataKey, accountKey: accountKey, keyID: "0")
        let canary = try mintCanary(accountKey: accountKey, userID: userID)
        let deviceEcdh = try deviceKeys.ecdhPublicKeyBase64
        let deviceMLKEM = deviceKeys.mlkemPublicKeyBase64
        let deviceAttestation = try sign(payload: attestation("thunderbolt-device-attestation-v1", userID, deviceID, deviceEcdh, deviceMLKEM), privateScalar: canary.signingPrivateScalar)
        let recovery = try generateRecoveryMaterial()
        let recoveryEcdh = try recovery.keys.ecdhPublicKeyBase64
        let recoveryMLKEM = recovery.keys.mlkemPublicKeyBase64
        let recoveryWrappedAK = try wrapAK(accountKey, recipient: recovery.keys, primaryKeyID: "0", keyVersion: 1)
        let recoveryAttestation = try sign(payload: attestation("thunderbolt-recovery-attestation-v1", userID, recovery.kdfSalt, recoveryEcdh, recoveryMLKEM), privateScalar: canary.signingPrivateScalar)
        let wrappedCK = try wrapAK(accountKey, recipient: deviceKeys, primaryKeyID: "0", keyVersion: 1)
        let request = DeviceBootstrapRequest(wrappedCK: wrappedCK, attestation: deviceAttestation, canaryIv: canary.iv, canaryCtext: canary.ciphertext, signingPublicKey: canary.signingPublicKey, kdfSalt: recovery.kdfSalt, wrappedKeys: [DeviceWrappedKey(keyId: "0", wrappedKey: wrappedDataKey)], recoveryEcdhPublicKey: recoveryEcdh, recoveryMlkemPublicKey: recoveryMLKEM, recoveryWrappedAK: recoveryWrappedAK, recoveryAttestation: recoveryAttestation)
        return FirstDeviceBootstrap(request: request, accountKey: accountKey, initialDataKey: dataKey, recoveryPhrase: recovery.phrase, keys: deviceKeys)
    }

    static func unwrapCanary(accountKey: Data, userID: String, iv: String, ciphertext: String) throws -> Data {
        guard let ivBytes = Data(base64Encoded: iv), let blob = Data(base64Encoded: ciphertext), blob.count >= 16 else { throw CryptoFailure.malformedValue }
        let aad = Data("__meta\u{001f}canary\u{001f}\(userID)\u{001f}__ak".utf8)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: ivBytes), ciphertext: Data(blob.dropLast(16)), tag: Data(blob.suffix(16)))
        return try AES.GCM.open(box, using: SymmetricKey(data: accountKey), authenticating: aad)
    }

    static func wrapAKForOrganization(_ accountKey: Data, publicKeyBase64: String) throws -> String {
        guard accountKey.count == 32, let publicKeyBytes = Data(base64Encoded: publicKeyBase64), publicKeyBytes.count == 65 else {
            throw CryptoFailure.malformedValue
        }
        let publicKey = try P256.KeyAgreement.PublicKey(x963Representation: publicKeyBytes)
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let ephemeralPublicKey = ephemeral.publicKey.x963Representation
        let sharedSecret = try ephemeral.sharedSecretFromKeyAgreement(with: publicKey).withUnsafeBytes { Data($0) }
        let wrappingKey = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: sharedSecret), salt: ephemeralPublicKey,
            info: Data("thunderbolt-org-escrow-ak-wrap-v1".utf8), outputByteCount: 32
        ).withUnsafeBytes { Data($0) }
        let wrapped = try aesKeyWrap(accountKey, key: wrappingKey)
        return (Data([0x01]) + ephemeralPublicKey + wrapped).base64EncodedString()
    }

    static func aesKeyWrap(_ keyToWrap: Data, key: Data) throws -> Data {
        guard key.count == 32, keyToWrap.count >= 16, keyToWrap.count.isMultiple(of: 8) else { throw CryptoFailure.invalidKey }
        var a = Data(repeating: 0xa6, count: 8)
        var blocks = stride(from: 0, to: keyToWrap.count, by: 8).map { Data(keyToWrap[$0..<$0 + 8]) }
        for round in 0..<6 {
            for index in blocks.indices {
                let encrypted = try aesEncryptBlock(a + blocks[index], key: key)
                let t = UInt64(blocks.count * round + index + 1)
                a = xorCounter(Data(encrypted.prefix(8)), t)
                blocks[index] = Data(encrypted.suffix(8))
            }
        }
        return blocks.reduce(a) { $0 + $1 }
    }

    private static func aesEncryptBlock(_ input: Data, key: Data) throws -> Data {
        guard input.count == 16, key.count == 32 else { throw CryptoFailure.invalidKey }
        var output = Data(count: 16)
        var moved = 0
        let status = output.withUnsafeMutableBytes { outputBytes in
            input.withUnsafeBytes { inputBytes in
                key.withUnsafeBytes { keyBytes in
                    CCCrypt(
                        CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionECBMode),
                        keyBytes.baseAddress, key.count, nil,
                        inputBytes.baseAddress, input.count, outputBytes.baseAddress, outputBytes.count, &moved
                    )
                }
            }
        }
        guard status == kCCSuccess, moved == 16 else { throw CryptoFailure.derivationFailed }
        return output
    }

    private static func xorCounter(_ block: Data, _ counter: UInt64) -> Data {
        var result = block
        for offset in 0..<8 {
            result[offset] ^= UInt8(truncatingIfNeeded: counter >> UInt64((7 - offset) * 8))
        }
        return result
    }

    static func signRecoveryAttestation(canary: CanaryMaterial, userID: String, kdfSalt: String, ecdhPublicKey: String, mlkemPublicKey: String) throws -> String {
        try sign(payload: attestation("thunderbolt-recovery-attestation-v1", userID, kdfSalt, ecdhPublicKey, mlkemPublicKey), privateScalar: canary.signingPrivateScalar)
    }

    static func signRecoveryAttestation(canarySeed: Data, userID: String, kdfSalt: String, ecdhPublicKey: String, mlkemPublicKey: String) throws -> String {
        try sign(payload: attestation("thunderbolt-recovery-attestation-v1", userID, kdfSalt, ecdhPublicKey, mlkemPublicKey), privateScalar: signingScalar(canarySeed: canarySeed))
    }

    static func verifyRecoveryAttestation(canarySeed: Data, signature: String, userID: String, kdfSalt: String, ecdhPublicKey: String, mlkemPublicKey: String) throws -> Bool {
        try verify(
            signature: signature,
            payload: attestation("thunderbolt-recovery-attestation-v1", userID, kdfSalt, ecdhPublicKey, mlkemPublicKey),
            canarySeed: canarySeed
        )
    }

    static func signPasskeyAttestation(canary: CanaryMaterial, userID: String, credentialID: String, ecdhPublicKey: String, mlkemPublicKey: String) throws -> String {
        try sign(
            payload: attestation("thunderbolt-passkey-attestation-v1", userID, credentialID, ecdhPublicKey, mlkemPublicKey),
            privateScalar: canary.signingPrivateScalar
        )
    }

    static func verifyPasskeyAttestation(canarySeed: Data, signature: String, userID: String, credentialID: String, ecdhPublicKey: String, mlkemPublicKey: String) throws -> Bool {
        try verify(
            signature: signature,
            payload: attestation("thunderbolt-passkey-attestation-v1", userID, credentialID, ecdhPublicKey, mlkemPublicKey),
            canarySeed: canarySeed
        )
    }

    private static func attestation(_ domain: String, _ values: String...) -> Data {
        Data(([domain] + values).joined(separator: "\u{001f}").utf8)
    }

    fileprivate static func sign(payload: Data, privateScalar: Data) throws -> String {
        let key = try P256.Signing.PrivateKey(rawRepresentation: privateScalar)
        return try key.signature(for: payload).rawRepresentation.base64EncodedString()
    }

    private static func signingScalar(canarySeed: Data) throws -> Data {
        try nobleScalar(hkdf(input: canarySeed, info: Data("thunderbolt-signing-v1".utf8), count: 48))
    }

    private static func verify(signature: String, payload: Data, canarySeed: Data) throws -> Bool {
        guard let signatureBytes = Data(base64Encoded: signature) else { return false }
        let publicKey = try P256.Signing.PrivateKey(rawRepresentation: signingScalar(canarySeed: canarySeed)).publicKey
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: signatureBytes)
        return publicKey.isValidSignature(signature, for: payload)
    }

    private static func nobleScalar(_ seed: Data) throws -> Data {
        guard let result = Data(base64Encoded: try NobleCryptoBridge.shared.invoke("p256Scalar", [seed.base64EncodedString()])), result.count == 32 else {
            throw CryptoFailure.bridge("Invalid P-256 scalar")
        }
        return result
    }

    private static func decodeRecoveryPhrase(_ phrase: String) throws -> Data {
        let normalized = phrase.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard let entropy = Data(base64Encoded: try NobleCryptoBridge.shared.invoke("mnemonicDecode", [normalized])), entropy.count == 32 else {
            throw CryptoFailure.malformedValue
        }
        return entropy
    }

    private static func jsonObject(_ json: String) throws -> [String: String] {
        guard let data = json.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
            throw CryptoFailure.bridge("Invalid cryptography module response")
        }
        return object
    }

    private static func decodeBase64(_ value: String?) -> Data? {
        value.flatMap { Data(base64Encoded: $0) }
    }

    private static func pbkdf2(seed: Data, salt: Data) throws -> Data {
        var output = Data(count: 64)
        let outputCount = output.count
        let status = output.withUnsafeMutableBytes { outputBytes in
            seed.withUnsafeBytes { seedBytes in
                salt.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), seedBytes.bindMemory(to: Int8.self).baseAddress, seed.count, saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA512), 600_000, outputBytes.bindMemory(to: UInt8.self).baseAddress, outputCount)
                }
            }
        }
        guard status == kCCSuccess else { throw CryptoFailure.derivationFailed }
        return output
    }

    private static func hkdf(input: Data, salt: Data = Data(), info: Data, count: Int) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: input), salt: salt, info: info, outputByteCount: count).withUnsafeBytes { Data($0) }
    }

    private static func hybridSealKey(sharedEcdh: Data, sharedMLKEM: Data, ecdhTranscript: Data, mlkemTranscript: Data) -> SymmetricKey {
        var input = sharedEcdh
        input.append(sharedMLKEM)
        var salt = ecdhTranscript
        salt.append(mlkemTranscript)
        return SymmetricKey(data: hkdf(input: input, salt: salt, info: Data("thunderbolt-hybrid-ak-seal-v2".utf8), count: 32))
    }

    private static func isMintableKeyID(_ value: String) -> Bool {
        guard value != "v1", !value.isEmpty, value.utf8.count <= 15,
              value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return false }
        return value == "0" || !value.hasPrefix("0")
    }

    private static func isWireKeyID(_ value: String) -> Bool {
        value == "v1" || isMintableKeyID(value)
    }

    static func isMintableKeyIDForCodec(_ value: String) -> Bool {
        isMintableKeyID(value)
    }

    static func isWireKeyIDForCodec(_ value: String) -> Bool {
        isWireKeyID(value)
    }
}
