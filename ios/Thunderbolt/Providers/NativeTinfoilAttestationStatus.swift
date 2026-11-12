/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Observation
import SwiftUI
import Tinfoil

enum NativeTinfoilAttestationState: Equatable, Sendable {
    case idle
    case verifying
    case verified
    case failed
}

struct NativeTinfoilMeasurement: Equatable, Sendable {
    let type: String
    let registers: [String]
}

struct NativeTinfoilAttestationDetails: Equatable, Sendable {
    let sourceRepository: String
    let releaseDigest: String
    let releaseTag: String?
    let codeMeasurement: NativeTinfoilMeasurement?
    let enclaveMeasurement: NativeTinfoilMeasurement?
    let tlsPublicKeyFingerprint: String
    let verifiedAt: Date
    let expiresAt: Date
    var endpoint: String?

    init(verification: Verification, endpoint: String? = nil) {
        sourceRepository = verification.configRepo
        releaseDigest = verification.codeDigest
        releaseTag = verification.codeTag
        codeMeasurement = verification.codeMeasurement.map {
            NativeTinfoilMeasurement(type: $0.type, registers: $0.registers)
        }
        enclaveMeasurement = verification.enclaveMeasurement.map {
            NativeTinfoilMeasurement(type: $0.type, registers: $0.registers)
        }
        tlsPublicKeyFingerprint = verification.tlsPublicKeyFingerprint
        verifiedAt = verification.verifiedAt
        expiresAt = verification.freshnessExpiresAt
        self.endpoint = endpoint
    }
}

struct NativeTinfoilAttestationSnapshot: Equatable, Sendable {
    let state: NativeTinfoilAttestationState
    let details: NativeTinfoilAttestationDetails?
    let failureMessage: String?

    static let idle = NativeTinfoilAttestationSnapshot(state: .idle, details: nil, failureMessage: nil)
}

struct NativeTinfoilAttestationCallbacks: Sendable {
    let onEnclaveVerified: EnclaveVerifiedCallback
    let onVerificationResult: VerificationResultCallback
    let onEndpoint: @Sendable (String) -> Void
}

/// Ephemeral, SDK-authenticated attestation evidence for the model picker.
/// These records never come from a model/provider JSON response.
@MainActor
@Observable
final class NativeTinfoilAttestationStatus {
    private(set) var snapshots: [String: NativeTinfoilAttestationSnapshot] = [:]
    private var endpoints: [String: String] = [:]
    private var generation = UUID()

    func snapshot(for key: String) -> NativeTinfoilAttestationSnapshot {
        let snapshot = snapshots[key] ?? .idle
        if snapshot.state == .verified, let details = snapshot.details, details.expiresAt <= Date() { return .idle }
        return snapshot
    }

    func callbacks(for key: String) -> NativeTinfoilAttestationCallbacks {
        let epoch = generation
        let verified: EnclaveVerifiedCallback = { [weak self] verification in
            let details = NativeTinfoilAttestationDetails(verification: verification)
            Task { @MainActor in guard self?.generation == epoch else { return }; self?.set(key, state: .verifying, details: details, failure: nil) }
        }
        let result: VerificationResultCallback = { [weak self] result in
            switch result {
            case .success(let verification):
                let details = NativeTinfoilAttestationDetails(verification: verification)
                Task { @MainActor in guard self?.generation == epoch else { return }; self?.set(key, state: .verified, details: details, failure: nil) }
            case .failure:
                Task { @MainActor in guard self?.generation == epoch else { return }; self?.set(key, state: .failed, details: nil, failure: nativeString( "The confidential connection could not be verified.")) }
            }
        }
        let endpoint: @Sendable (String) -> Void = { [weak self] endpoint in
            Task { @MainActor in guard self?.generation == epoch else { return }; self?.setEndpoint(key, endpoint: endpoint) }
        }
        return NativeTinfoilAttestationCallbacks(
            onEnclaveVerified: verified,
            onVerificationResult: result,
            onEndpoint: endpoint
        )
    }

    func markVerifying(_ key: String) {
        set(key, state: .verifying, details: nil, failure: nil)
    }

    func clear(_ key: String) {
        snapshots[key] = .idle
    }

    func fail(_ key: String, message: String) { set(key, state: .failed, details: nil, failure: message) }

    func clearAll() {
        generation = UUID()
        snapshots = [:]
        endpoints = [:]
    }

    private func set(
        _ key: String,
        state: NativeTinfoilAttestationState,
        details: NativeTinfoilAttestationDetails?,
        failure: String?
    ) {
        var details = details
        details?.endpoint = endpoints[key]
        snapshots[key] = NativeTinfoilAttestationSnapshot(state: state, details: details, failureMessage: failure)
    }

    private func setEndpoint(_ key: String, endpoint: String) {
        endpoints[key] = endpoint
        let previous = snapshot(for: key)
        guard let details = previous.details else { return }
        var updated = details
        updated.endpoint = endpoint
        snapshots[key] = NativeTinfoilAttestationSnapshot(state: previous.state, details: updated, failureMessage: previous.failureMessage)
    }
}

struct NativeTinfoilAttestationDetailsView: View {
    let snapshot: NativeTinfoilAttestationSnapshot

    var body: some View {
        switch snapshot.state {
        case .idle:
            Label(nativeString( "Not verified"), systemImage: "lock.open")
                .foregroundStyle(.secondary)
        case .verifying:
            Label(nativeString( "Verifying confidential connection"), systemImage: "lock.rotation")
        case .failed:
            Label(snapshot.failureMessage ?? nativeString( "Verification failed"), systemImage: "exclamationmark.shield.fill")
                .foregroundStyle(.red)
        case .verified:
            verifiedDetails
        }
    }

    @ViewBuilder
    private var verifiedDetails: some View {
        if let details = snapshot.details {
            VStack(alignment: .leading, spacing: 10) {
                Label(nativeString( "Verified on this device"), systemImage: "checkmark.shield.fill")
                    .foregroundStyle(.green)
                DisclosureGroup(nativeString( "Connection details")) {
                    VStack(alignment: .leading, spacing: 8) {
                        detail(nativeString( "Source repository"), details.sourceRepository)
                        detail(nativeString( "Release digest"), details.releaseDigest)
                        if let endpoint = details.endpoint { detail(nativeString( "Enclave endpoint"), endpoint) }
                        if let measurement = details.enclaveMeasurement {
                            detail(nativeString( "Enclave measurement"), ([measurement.type] + measurement.registers).joined(separator: "\n"))
                        }
                        if let code = details.codeMeasurement {
                            detail(nativeString( "Build measurement"), ([code.type] + code.registers).joined(separator: "\n"))
                        }
                        detail(nativeString( "Verified"), details.verifiedAt.formatted(date: .abbreviated, time: .shortened))
                    }
                    .padding(.top, 8)
                }
                .font(.footnote)
            }
        } else {
            Label(nativeString( "Verified"), systemImage: "checkmark.shield.fill")
                .foregroundStyle(.green)
        }
    }

    private func detail(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).foregroundStyle(.secondary)
            Text(value).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
