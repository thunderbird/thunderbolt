/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct DevicesView: View {
    @Bindable var model: AppModel
    @State private var approvalTarget: NativeAccountDevice?
    @State private var revokeTarget: NativeAccountDevice?
    @State private var isRevokeConfirmationPresented = false
    @State private var isWorking = false
    @State private var managementMessage: String?
    @State private var managementError: String?

    var body: some View {
        TBSettingsPage(nativeString("Devices")) {
            if model.accountDevices.isEmpty {
                ContentUnavailableView("No devices yet", systemImage: "desktopcomputer.and.iphone",
                    description: Text("Your devices appear here after sync connects."))
            }
            ForEach(model.accountDevices) { device in
                HStack(spacing: 12) {
                    Image(systemName: device.deviceType == "cli" ? "terminal" : "desktopcomputer.and.iphone")
                        .foregroundStyle(TBPalette.muted)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(device.name)
                        if device.id == model.deviceCoordinator?.record?.id {
                            Text("This device").tbFont(size: 14).foregroundStyle(TBPalette.muted)
                        } else if device.revokedAt != nil {
                            Text("Revoked").tbFont(size: 14).foregroundStyle(TBPalette.muted)
                        } else if device.trusted {
                            Text("Trusted").tbFont(size: 14).foregroundStyle(TBPalette.muted)
                        } else {
                            Text("Waiting for approval").tbFont(size: 14).foregroundStyle(TBPalette.muted)
                        }
                    }
                    Spacer()
                    if device.approvalPending && !device.trusted && device.revokedAt == nil && device.isAppDevice {
                        Button("Approve") { approvalTarget = device }
                            .disabled(model.deviceCoordinator?.state != .ready)
                            .accessibilityIdentifier("approveDevice-\(device.id)")
                    }
                    if device.trusted, device.revokedAt == nil,
                       device.id != model.deviceCoordinator?.record?.id {
                        Menu {
                            Button("Revoke access", role: .destructive) {
                                revokeTarget = device
                                isRevokeConfirmationPresented = true
                            }
                            .accessibilityIdentifier("revokeDevice-\(device.id)")
                        } label: {
                            Image(systemName: "ellipsis.circle")
                                .font(.title3)
                                .foregroundStyle(TBPalette.muted)
                        }
                        .disabled(isWorking || model.deviceCoordinator?.state != .ready)
                        .accessibilityLabel("Device actions for \(device.name)")
                    }
                }
                .tbFont(size: 16)
                .padding(16)
                .frame(minHeight: 72)
                .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
            }
            if let error = model.syncError {
                Text(error).tbFont(size: 14).foregroundStyle(.red)
            }
            if let managementError {
                Text(managementError).tbFont(size: 14).foregroundStyle(.red)
                    .accessibilityIdentifier("deviceManagementError")
            }
            if let managementMessage {
                Text(managementMessage).tbFont(size: 14).foregroundStyle(TBPalette.muted)
                    .accessibilityIdentifier("deviceManagementMessage")
            }
            if let coordinator = model.deviceCoordinator, !coordinator.lockoutPendingDeviceIDs.isEmpty {
                TBSettingsSection(nativeString("Key lockout needed")) {
                    Text("A device was cut off, but its encryption key has not been rotated yet. Finish the lockout to prevent it from reading new conversations.")
                        .tbFont(size: 14)
                        .foregroundStyle(TBPalette.muted)
                    Button {
                        perform {
                            try await model.finishDeviceLockout()
                            managementMessage = nativeString( "The device lockout is complete.")
                        }
                    } label: {
                        HStack {
                            Text("Finish key lockout")
                            Spacer()
                            if isWorking { ProgressView() }
                        }
                    }
                    .disabled(isWorking || coordinator.state != .ready)
                    .accessibilityIdentifier("finishDeviceLockout")
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await model.watchAccountDevices() }
        .refreshable { await model.enableSync() }
        .confirmationDialog(
            "Revoke access for \(revokeTarget?.name ?? "this device")?",
            isPresented: $isRevokeConfirmationPresented,
            titleVisibility: .visible
        ) {
            Button("Revoke access", role: .destructive) {
                guard let target = revokeTarget else { return }
                perform {
                    let lockoutPending = try await model.revokeDevice(id: target.id)
                    managementMessage = lockoutPending
                        ? nativeString( "Access was cut off. Finish the key lockout to rotate the account key.")
                        : nativeString( "Device access was revoked and the account key was rotated.")
                    revokeTarget = nil
                }
            }
            Button("Cancel", role: .cancel) { revokeTarget = nil }
        } message: {
            Text("This signs the device out and rotates the account encryption key. The device cannot read new conversations after the rotation completes.")
        }
        .sheet(item: $approvalTarget) { device in
            DeviceApprovalView(model: model, device: device)
        }
    }

    private func perform(_ operation: @escaping () async throws -> Void) {
        guard !isWorking else { return }
        isWorking = true
        managementError = nil
        managementMessage = nil
        Task {
            do { try await operation() }
            catch { self.managementError = error.localizedDescription }
            isWorking = false
        }
    }
}

private struct DeviceApprovalView: View {
    let model: AppModel
    let device: NativeAccountDevice
    @Environment(\.dismiss) private var dismiss
    @State private var prompt: ApprovalCodePrompt?
    @State private var error: String?
    @State private var isApproving = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Image(systemName: "lock.shield").font(.system(size: 42, weight: .light))
                    .foregroundStyle(TBPalette.brand)
                Text("Approve \(device.name)?").font(.title2.weight(.semibold))
                Text("Choose the code shown on that device. Only approve a device you recognize.")
                    .foregroundStyle(TBPalette.muted)
                    .multilineTextAlignment(.center)
                if let prompt {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        ForEach(prompt.options, id: \.self) { code in
                            Button {
                                isApproving = true
                                Task {
                                    do { try await model.approveDevice(device.id, code: code); dismiss() }
                                    catch { self.error = error.localizedDescription }
                                    isApproving = false
                                }
                            } label: {
                                Text(code).font(.system(.title2, design: .monospaced).weight(.semibold))
                                    .frame(maxWidth: .infinity).frame(height: 56)
                            }
                            .buttonStyle(TBPrimaryButtonStyle())
                            .disabled(isApproving)
                            .accessibilityIdentifier("approvalChoice-\(code)")
                        }
                    }
                } else if error == nil { ProgressView("Waiting for the other device…") }
                if let error { Text(error).foregroundStyle(.red).accessibilityIdentifier("approvalError") }
                Spacer(minLength: 0)
            }
            .padding(24)
            .background(TBPalette.background)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } }
            }
            .task {
                do {
                    try await model.challengeDevice(device)
                    while !Task.isCancelled {
                        if let choices = try await model.approvalChoices(for: device.id) {
                            prompt = choices
                            return
                        }
                        try await Task.sleep(for: .seconds(2))
                    }
                } catch is CancellationError {
                } catch { self.error = error.localizedDescription }
            }
        }
        .tint(TBPalette.brand)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
