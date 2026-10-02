# Publishing openmesh-node

The npm package already exists at version 0.2.0. The next prepared release is 0.4.0; 0.3.0 was never published and its changes are included in 0.4.0.

## Release model

Releases are tag-driven. The package version in `package.json` must exactly match the Git tag:

```text
package.json: 0.4.0
Git tag:      v0.4.0
```

Pushing the tag triggers `.github/workflows/publish.yml`. The workflow refuses to publish when the tag/version pair does not match or when that exact version is already present in npm.

Before creating a release tag, merge the prepared release commit to `master` and make sure the normal CI workflow is green.

## npm trusted publisher

Publishing is designed to use npm Trusted Publishing through GitHub Actions OIDC rather than a long-lived npm write token.

Configure the package on npmjs.com with:

- Provider: GitHub Actions
- Organization/user: `yaohuangguan`
- Repository: `openmesh-node`
- Workflow filename: `publish.yml`
- Allow direct `npm publish`
- Environment: leave unset unless the workflow is updated to use the same GitHub environment

The workflow grants `id-token: write`, runs on a GitHub-hosted runner, and installs an npm CLI version that supports trusted publishing. A local `npm whoami` failure does not determine whether GitHub OIDC publishing is configured.

Do not commit npm passwords, OTPs, access tokens, or generated `.npmrc` credentials.

## Release checklist

From a clean checkout of the release commit:

```sh
npm ci --ignore-scripts
npm test
npm run test:types
npm run test:package
npm run demo:cluster
npm run demo:services
npm pack --dry-run
```

`test:package` builds the project, creates the real npm tarball, installs it into a temporary consumer project, and verifies every public CommonJS and ESM export.

The publish workflow repeats these checks before publication.

## Publishing 0.4.0

Once the release commit is on `master` and CI is green:

```sh
git switch master
git pull --ff-only
git tag -a v0.4.0 -m "openmesh-node 0.4.0"
git push origin v0.4.0
```

The tag triggers the npm publishing workflow. Do not move or reuse a published version tag.

After the workflow succeeds, verify:

```sh
npm view openmesh-node@0.4.0 version dist.integrity
```

Then create the GitHub release from `v0.4.0` using the 0.4.0 changelog section as the release notes.

## Manual recovery

If Trusted Publishing has not yet been configured, the tag workflow should fail before a successful npm publication rather than falling back to a repository token.

A maintainer can either configure the Trusted Publisher and rerun the workflow, or perform an intentional local publish after interactive npm authentication:

```sh
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm run prepublishOnly
npm publish --access public --provenance
```

Do not publish a different commit under the same version. If a published release contains a defect, prepare a new version.
