# Releasing script-vm-next

The release target for this milestone is `0.2.0-beta.1`. Package validation, browser validation, Pages deployment, and registry publication are separate operations. A passing build does not prove that npm publication or Pages deployment has occurred.

## Maintainer prerequisites

1. Confirm ownership or publish rights for the npm **`@momeak`** user/organization scope. A matching GitHub name does not grant npm scope access. If it is an organization, the publisher needs write access through an authorized team. Scoped packages default to private on npm, so this project explicitly sets `publishConfig.access: public` and publishes with `--access public`. The workflow targets the public package `@momeak/script-vm-next` on `https://registry.npmjs.org`.
2. The project uses **Apache-2.0** as selected by the maintainer. Keep the full `LICENSE`, attribution `NOTICE`, and matching `package.json` license in the verified tarball. Preserve third-party notices and licenses.
3. Create a GitHub Actions environment named **`npm`** under repository Settings → Environments. Restrict it to release tags and, if appropriate for your project, require a maintainer review. The workflow's `environment: npm` must match the npm Trusted Publisher settings exactly.
4. Configure an npm **Trusted Publisher** for the package: provider **GitHub Actions**, owner **`MoMeak9`**, repository **`script-vm-next`**, workflow filename **`release.yml`**, and environment **`npm`**. These identifiers are case-sensitive where enforced by the service. Use the workflow filename, not its display name or a filesystem path.
5. Ensure Actions can run in the repository and that the chosen ref contains the release workflow. OIDC publication runs on GitHub-hosted Ubuntu runners with `id-token: write` and npm **11.5.1 or newer**.

Publishing credentials belong in npm's secure login flow or GitHub's environment/secret settings. Do not put tokens in source files, `.npmrc`, issues, or chat. The normal release workflow uses OIDC and does not need `NPM_TOKEN` or `NODE_AUTH_TOKEN`.

The package's `repository` URL must match the GitHub repository. Public npm publication with `--provenance` also requires a supported public source repository. The release workflow is intended for this public GitHub project.

## First publication when the package does not yet exist

npm Trusted Publisher configuration is normally attached to an existing package. If `@momeak/script-vm-next` does not yet exist and npm does not offer its publisher configuration, use the explicit one-time bootstrap mode:

1. Merge the scoped publishing changes into `main`. Confirm the release commit passed CI and that `package.json` and `src/version.ts` both contain `0.2.0-beta.1`.
2. In npm, create a short-lived **granular access token** with permission to create/publish packages under `@momeak`. If the token UI offers access to all packages in this scope, choose the narrowest scope permission that allows the initial package creation. Enable **Bypass 2FA** for noninteractive publication if required by your account policy. An organization policy that forbids such tokens requires the local authenticated bootstrap below instead.
3. Add the token as the GitHub **environment secret** `NPM_BOOTSTRAP_TOKEN` in the repository's `npm` environment. Do not add it to the cloud environment or put its value in chat, commands or files.
4. Create and push `v0.2.0-beta.1` on that reviewed commit. Tag pushes always use OIDC; before the package and Trusted Publisher exist, that first automatic run can fail authentication. It does not switch to a token silently. Wait for that run to finish before the manual bootstrap.
5. Run **npm release** manually on the exact release tag, choosing `authentication: bootstrap-token`. With an authenticated GitHub CLI, the equivalent command is:

   ```sh
   gh workflow run release.yml --repo MoMeak9/script-vm-next --ref v0.2.0-beta.1 -f authentication=bootstrap-token
   ```

   A branch ref is rejected. The run repeats all reusable CI checks, publishes the verified scoped tarball with `--access public --tag beta --provenance`, and checks the registry version and dist-tag. The token is available only in this explicitly selected publish step.
6. Once the package exists, configure its npm **Trusted Publisher** with the exact values in the prerequisites above. Revoke the bootstrap token and remove `NPM_BOOTSTRAP_TOKEN` from the GitHub environment. Subsequent matching version tags use OIDC without a long-lived token; use a new version such as `0.2.0-beta.2`, since npm versions are immutable.

If a Trusted Publisher can already be configured for the package, skip the token and bootstrap dispatch; use the ordinary tag workflow. A manual rerun can use `authentication: trusted-publisher` on a matching tag whose version has not yet been published.

If token bootstrap is unavailable, use a trusted maintainer machine: check out the reviewed release commit, run all validation commands below, log in with `npm login --registry=https://registry.npmjs.org`, complete account two-factor authentication, then publish the verified tarball:

```sh
npm publish ./artifacts/momeak-script-vm-next-0.2.0-beta.1.tgz --access public --tag beta --ignore-scripts --registry=https://registry.npmjs.org
```

The local fallback does not create a GitHub Actions provenance attestation. Configure Trusted Publishing immediately after the package exists. The workflow cannot create your npm account, scope permissions, token, or Trusted Publisher configuration; those account-side settings require an authorized maintainer.

## Validate a release

Use Node.js 24 and pnpm 10.34.6:

```sh
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm build
pnpm lint
pnpm typecheck
pnpm test:unit:runtimes
pnpm test:test262
pnpm test:package
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

The independent consumer check packs with lifecycle scripts disabled, checks the archive file list, installs it into a temporary production consumer, verifies named ESM and CommonJS imports, checks strict TypeScript declarations, compiles through both public entry points, and executes the installed CLI. The verified archive is saved as `artifacts/momeak-script-vm-next-<version>.tgz`.

`pnpm test:e2e` builds the production playground and tests its project-subpath deployment, compilation, execution, diagnostics, limits, stopping and recovery, and selected isolation boundaries in Chromium. Keep the compatibility document and example expectations aligned with these checks. A passing suite only establishes the cases it exercises.

## Automated version release

1. Update `package.json` and `src/version.ts` to the same intended version; the build checks that they match. Update the lockfile as needed, along with release notes and relevant docs. Do not reuse an already published npm version.
2. Review and merge the changes through the MR. Confirm CI has passed on the commit to be released.
3. Create and push a matching tag, for example `v0.2.0-beta.2`, on that reviewed commit. This is the publication action: it triggers `.github/workflows/release.yml`.
4. Review any configured `npm` environment approval, then monitor the workflow. Verify the registry version, its provenance, dist-tags, and a clean installation.

The workflow checks that the tag equals `v` + `package.json.version`, requires an approved license and `LICENSE`, and runs the reusable CI workflow. The publish job downloads the same tarball that the independent consumer tests verified. It publishes that artifact with `--ignore-scripts`, `--access public`, and `--provenance`; it does not rebuild it after validation.

Every prerelease version, including `0.2.0-beta.1`, is published to the **`beta`** dist-tag. Only a version without a prerelease suffix is assigned **`latest`**. Promoting a beta to a stable release requires a deliberate new stable version and matching tag; a beta tag must not replace `latest`.

Verify using the exact released version:

```sh
npm view @momeak/script-vm-next@0.2.0-beta.2 version dist.integrity --registry=https://registry.npmjs.org
npm dist-tag ls @momeak/script-vm-next --registry=https://registry.npmjs.org
```

Inspect provenance on the package's npm page and test a fresh consumer installation. Preserve the release tag and workflow run so consumers can trace the artifact to its source commit.

After publication, run the [independent order-pricing integration reference](../examples/order-pricing/README.md) with the exact registry version, recording the environment and result. Collect real-project trials through the Beta integration issue template and follow the [evidence and attribution rules](integrations.md) before documenting external adoption. Repository tests and internal examples do not establish external production use.

## GitHub Pages releases

See [playground deployment](playground.md). The Pages workflow publishes the validated static demo on a `main` push or manual workflow dispatch. A **`demo-v*`** tag can deploy a specifically reviewed demo commit before its MR is merged; for example `demo-v0.2.0-beta.1`. That tag does not trigger the npm workflow, which only matches `v*` tags.

The page displays its package version and source commit. `main` may contain unreleased changes, so the displayed npm version alone does not prove parity with a registry release; use the commit identifier or deploy the exact release commit. If npm and the demo must match strictly, dispatch Pages at that release ref.

## Troubleshooting

- **License gate failed:** select the license through the copyright holder and include its text. Do not remove the gate or publish an `UNLICENSED` artifact to get a green run.
- **Tag mismatch:** tag the commit whose manifest has the desired version; do not publish a differently versioned archive under the tag.
- **Bootstrap authentication failed:** verify the `npm` environment secret name, token expiry, `@momeak` creation/write permissions, and any required Bypass 2FA setting. The workflow does not consume this token on ordinary tag pushes.
- **OIDC authentication failed:** check npm's exact owner, repository, workflow filename, environment, the workflow's `id-token: write` permission, GitHub-hosted runner, npm version, and package ownership. GitHub checkout access does not establish npm publishing rights.
- **Provenance failed:** check repository visibility, the manifest's repository URL, and npm/GitHub OIDC requirements. Preserve the provenance requirement for automated releases.
- **Version already exists:** npm versions are immutable. Inspect the published version and bump the next release instead of repeatedly rerunning the same publish.
- **Pages failed:** first check validation, then Pages' Actions source and the `github-pages` environment's allowed deployment refs. The demo requires its configured `/script-vm-next/` base path.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and [GitHub custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
