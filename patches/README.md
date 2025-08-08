# Patches

This directory contains patches for npm packages to fix issues or add functionality.

## @flwr/flwr

The Flower SDK has a hardcoded URL to `api.flower.ai` which causes CORS issues when used in the browser. Our patch adds support for configuring a custom base URL.

### Changes Made

1. Added static `baseUrl` setter and getter to `FlowerIntelligence` class
2. Modified the remote engine constructor to use the custom base URL if set
3. Updated TypeScript definitions to include the new methods

### How It Works

The patch modifies the SDK to check for a custom base URL before defaulting to `api.flower.ai`. This allows us to redirect all Flower API calls through our backend proxy at `/flower`, avoiding CORS issues.

### Applying the Patch

The patch is automatically applied during `bun install` via the `postinstall` script in `package.json`.

To manually apply the patch:

```bash
patch -p0 < patches/@flwr+flwr+0.1.13.patch
```

### Creating/Updating the Patch

If you need to update the patch after modifying the Flower SDK:

1. Make your changes to `node_modules/@flwr/flwr/dist/flowerintelligence.es.js`
2. Create the patch:
   ```bash
   diff -u node_modules/@flwr/flwr/dist/flowerintelligence.es.js.orig node_modules/@flwr/flwr/dist/flowerintelligence.es.js > patches/@flwr+flwr+0.1.13.patch
   ```
3. Test that the patch applies cleanly:
   ```bash
   bun run postinstall
   ```

