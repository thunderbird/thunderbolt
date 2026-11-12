# Native Iroh transport prototype

This folder preserves the native Swift Iroh transport prototype outside the Xcode synchronized `Thunderbolt` target. It is intentionally excluded from the experimental app build because the pinned `IrohLib` package has not yet been added to the Xcode project and the transport has not completed its build and integration checks.

The prototype contains the Keychain identity store, a shared endpoint client, cancellable dial gate, and ACP/MCP newline-delimited JSON stream. It is not currently available to the app; native MCP reports Iroh as unsupported until the package and transport are integrated and verified.

The intended dependency is `n0-computer/iroh-ffi` tag `v1.2.0` at commit `66a8d619a4d791d458d582f312df6e0ab42bc541`. Integration must also add the package product and required Apple frameworks to the Xcode project, add codec/lifecycle tests, wire account cleanup to remove the Keychain identity, and run the app/test targets.
