# Publishing openmesh-node

The initial 0.2.0 release is prepared. At preparation time `npm whoami` returned 401; publication has not occurred. The maintainer chose to authenticate later. Package name: `openmesh-node`; registry: `https://registry.npmjs.org`.

## Initial publication

Run these commands from a verified checkout on a machine authenticated as the intended npm owner:

```sh
npm ci --ignore-scripts
npm test
npm run test:types
npm run demo:services
npm pack --dry-run
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish --access public
```

Complete npm's interactive browser/2FA challenge when requested. Do not put account tokens, passwords or OTPs into commits or issues. The tarball uses an explicit file allowlist; it contains runtime source, types, examples and documentation, with no native benchmark executable or development dependencies bundled.

After publishing:

```sh
npm view openmesh-node@0.2.0 version dist.integrity
```

Install the registry package in a fresh consumer and verify ESM/CommonJS imports and a real service request. Then update the main README's installation command to `npm install openmesh-node`, removing the pending-publication text. An immutable version already published cannot be overwritten; choose a new version for subsequent changes.

## Future trusted publishing

The repository includes `.github/workflows/publish.yml`, triggered manually. After the package exists, configure its npm trusted publisher for:

- Owner: `yaohuangguan`
- Repository: `openmesh-node`
- Workflow filename: `publish.yml`

The workflow requests a short-lived OIDC identity and validates tests before publication. Its presence alone does not authenticate npm; the npm package settings must authorize it. [npm trusted-publishing documentation](https://docs.npmjs.com/trusted-publishers/).
