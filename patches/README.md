# Patches

Patches modify installed npm packages to fix bugs or add features not available in the published version.

## How it works

Patches are automatically applied during `bun install` via the `postinstall` script. Files follow the pattern `@scope+package+version.patch`.

## Creating a patch

1. Make changes to files in `node_modules/package-name/`
2. Run: `bun patch-package package-name`
3. Commit the generated `.patch` file

## Best practices

- Keep patches minimal
- Document why changes are needed
- Update patches when upgrading packages
- Consider alternatives before patching

Patches create dependencies on package internals that may change between versions.
