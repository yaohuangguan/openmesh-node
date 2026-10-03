# Publishing openmesh-node

OpenMesh releases are tag-driven and published to npm through GitHub Actions Trusted Publishing.

## Release model

The package version in `package.json` must exactly match the Git tag:

```text
package.json: 0.5.0
Git tag:      v0.5.0
```

Pushing a `v*` tag triggers `.github/workflows/publish.yml`. The workflow refuses to publish when the tag/version pair does not match or when that exact version already exists on npm.

Before tagging:

1. merge the release commit to `master`;
2. make sure normal CI is green;
3. make sure the exact npm version is still unpublished;
4. never move or reuse a published version tag.

## npm Trusted Publishing

Publishing uses npm Trusted Publishing through GitHub Actions OIDC instead of a long-lived npm write token.

The npm package is configured for:

- Provider: GitHub Actions
- Organization/user: `yaohuangguan`
- Repository: `openmesh-node`
- Workflow filename: `publish.yml`
- Direct `npm publish`: enabled
- Environment: unset unless the workflow is changed to use one

The workflow grants `id-token: write` and publishes with provenance.

Do not commit npm passwords, OTPs, access tokens, or generated `.npmrc` credentials.

## Release checklist

From a clean checkout of the release commit:

```sh
npm ci --ignore-scripts
npm run prepublishOnly
npm run demo:cluster
npm run demo:services
npm pack --dry-run
git diff --check
```

`test:package` is included by `prepublishOnly`. It builds the real package tarball, installs it in a temporary consumer project, and verifies every public CommonJS and ESM export.

For `0.5.0`, also confirm that typed CRUD, `openmesh-node/db`, service discovery, `app.mesh()`, traffic policy, workload identity/mTLS, certificate rotation, Redis integration, and benchmark regression are green in CI.

## Publishing 0.5.0

Once the release commit is on `master` and CI is green:

```sh
git switch master
git pull --ff-only
git tag -a v0.5.0 -m "openmesh-node 0.5.0"
git push origin v0.5.0
```

The tag triggers npm publication. The separate GitHub Release workflow creates `OpenMesh 0.5.0` from the tagged changelog section.

After npm propagation, verify:

```sh
npm view openmesh-node@0.5.0 version dist.integrity --prefer-online
npm view openmesh-node dist-tags.latest --prefer-online
```

Then install from a clean temporary project and load the root package plus public subpaths.

## Recovery

If publication fails before npm accepts the package, fix the workflow/configuration and rerun the same immutable tag.

If npm has already accepted the version, do not rerun a publish path that can attempt to overwrite it. Verify registry propagation first.

Never publish a different commit under the same version. Prepare a new patch version for any post-release fix.
