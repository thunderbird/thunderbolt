# PR #548 Review — THU-390: Enterprise Sandbox Followup

## Issues

### 1. Version tags are not unique per run (medium)

`images-publish.yml` reads the image version from `package.json`:

```yaml
VERSION=$(jq -r .version package.json)
```

The old workflow used CalVer (`YYYY.MM.DD.run_number`), which guaranteed a unique tag every run. With the new scheme, two consecutive pushes to `main` without a version bump both publish to the same tag — silently overwriting the previous image and breaking traceability.

Consider appending the short SHA: `${VERSION}-${GITHUB_SHA::7}`, or restoring CalVer for CI-built images.

---

### 2. `no-cache: true` on all Docker builds slows PR preview builds (medium)

Every image build step has `no-cache: true`, including when `images-publish.yml` is called from `preview-deploy.yml` on each PR push. With 6 images, this means every commit to a PR triggers 6 full cold builds. Consider using `cache-from`/`cache-to` (GHCR or GitHub Actions cache) at least for preview builds.

---

### 3. `imagePrefix` hardcoded in `deploy/pulumi/index.ts` (low)

```ts
const imagePrefix = 'ghcr.io/thunderbird/thunderbolt'
```

The publish workflow derives the prefix dynamically from `${{ github.repository }}`, so they currently match. But a repo rename or fork would silently pull images from the wrong registry without a TypeScript or Pulumi error. Pulling this from Pulumi config or a stack output would keep the two in sync.

---

### 4. Sandbox secret defaults are intentional but worth documenting (low)

```ts
postgresPassword: config.getSecret('postgresPassword') ?? pulumi.output('postgres'),
keycloakAdminPassword: config.getSecret('keycloakAdminPassword') ?? pulumi.output('admin'),
```

These defaults are fine for sandbox/demo stacks, and the comment calls them out. Just ensure the runbook for customer-facing deployments includes `pulumi config set --secret` for each of these before bringing a stack up.

---

### 5. Pulumi CLI installed unpinned in `preview-cleanup.yml` (low)

```yaml
run: |
  curl -fsSL https://get.pulumi.com | sh
```

`stack-deploy.yml` pins its Pulumi version via `pulumi/actions@<sha>`. The cleanup workflow fetches whatever the latest CLI is at runtime, which can introduce version drift or break on a major release. Using the `pulumi/actions` installer with a pinned version hash would be consistent with the rest of the pipeline.
